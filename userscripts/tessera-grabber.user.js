// ==UserScript==
// @name         Tessera 资源抓取
// @namespace    https://github.com/yangshoulai/tgdrive
// @version      0.5.0
// @description  在 X、YouTube 和其他网页上快速复制媒体地址与 curl 命令，或一键发送到 Tessera 离线下载
// @author       yangshoulai
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2032%2032%27%3E%3Crect%20width%3D%2732%27%20height%3D%2732%27%20rx%3D%278%27%20fill%3D%27%230b0c13%27%2F%3E%3Crect%20x%3D%275%27%20y%3D%275%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%2F%3E%3Crect%20x%3D%275%27%20y%3D%2717%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%20fill-opacity%3D%27.6%27%2F%3E%3Crect%20x%3D%2717%27%20y%3D%2717%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%20fill-opacity%3D%27.32%27%2F%3E%3Cpolygon%20points%3D%2718.2%2C6.2%2025.8%2C6.2%2025.8%2C13.8%27%20fill%3D%27%23f0a22e%27%20stroke%3D%27%23f0a22e%27%20stroke-width%3D%272.4%27%20stroke-linejoin%3D%27round%27%2F%3E%3Cpath%20d%3D%27M25.1%206.9%2022.2%209.8%27%20stroke%3D%27%23c27a10%27%20stroke-width%3D%271.1%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
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

  // siteMode：exclude = 所有网站，排除 excludeSites；include = 只在 includeSites 中的网站。两份列表分开保存，切换模式互不覆盖。
  const DEFAULTS = { server: "", key: "", destination: "", cookies: true, fab: true, siteMode: "exclude", excludeSites: [], includeSites: [] };
  const settings = () => ({ ...DEFAULTS, ...GM_getValue("settings", {}) });
  const saveSettings = value => GM_setValue("settings", { ...settings(), ...value });

  // ---------- 已发送记录 ----------

  // 发送成功的资源地址持久保存（跨页面、跨标签页），列表里标「已发送」，全选与批量发送时自动跳过；任务失败时移除。
  const SENT_LIMIT = 1000;
  const sentList = () => GM_getValue("sent", []);
  const isSent = url => sentList().includes(url);
  function markSent(urls, sent = true) {
    const set = new Set(urls);
    const rest = sentList().filter(url => !set.has(url));
    GM_setValue("sent", sent ? [...rest, ...set].slice(-SENT_LIMIT) : rest);
  }

  // ---------- 显示范围 ----------

  /** 站点规则统一成域名：去掉协议、路径、端口和开头的 *.；一条规则匹配该域名及其所有子域名。无效时返回空串。 */
  function normalizeSite(value) {
    let text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
      try { text = new URL(text).hostname; } catch { return ""; }
    }
    // www. 不算独立站点：去掉后规则同时覆盖裸域名和其他子域名。
    text = text.replace(/^\*\./, "").replace(/[/?#:].*$/, "").replace(/^\.+|\.+$/g, "").replace(/^www\./, "");
    return text && !/[\s*]/.test(text) && text.includes(".") || text === "localhost" ? text : "";
  }
  const currentSite = () => location.hostname.toLowerCase().replace(/^www\./, "");
  const matchesSite = rule => { const host = location.hostname.toLowerCase(); return host === rule || host.endsWith("." + rule); };
  const siteList = value => (value.siteMode === "include" ? value.includeSites : value.excludeSites) || [];

  /** 当前网站是否启用：Tessera 站点始终停用，其余按显示范围判断。 */
  function siteEnabled(value = settings()) {
    if (onTessera()) return false;
    const hit = siteList(value).some(rule => matchesSite(normalizeSite(rule)));
    return value.siteMode === "include" ? hit : !hit;
  }

  /** 面板与菜单里的「在此网站启用／停用」：只改当前模式对应的列表。 */
  function setSiteEnabled(enabled) {
    const value = settings();
    const key = value.siteMode === "include" ? "includeSites" : "excludeSites";
    const keep = (value[key] || []).filter(rule => !matchesSite(normalizeSite(rule)));
    const add = value.siteMode === "include" ? enabled : !enabled;
    saveSettings({ [key]: add ? [...keep, currentSite()] : keep });
    applySiteState();
    toast(enabled ? `已在 ${currentSite()} 上启用` : `已在 ${currentSite()} 上隐藏，可从 Tampermonkey 菜单恢复`);
  }

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

  let networkObserver = null;
  function observeNetwork() {
    const Observer = page.PerformanceObserver || window.PerformanceObserver;
    if (!Observer || networkObserver) return;
    try {
      networkObserver = new Observer(list => {
        for (const entry of list.getEntries()) {
          const type = classify(entry.name, entry.initiatorType);
          if (type) addItem(entry.name, type, { source: "网络" });
        }
      });
      networkObserver.observe({ type: "resource", buffered: true });
    } catch { networkObserver = null; /* 浏览器不支持资源计时 */ }
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
    * { box-sizing: border-box; margin: 0; }
    [hidden] { display: none !important; }
    .root {
      --bg: #ffffff; --fg: #18181b; --muted: #71717a; --faint: #a1a1aa; --line: #ececef; --soft: #f4f4f5; --hover: #f6f6f7;
      --accent: #2f4bd0; --accent-hover: #2840b4; --accent-soft: rgba(47, 75, 208, .09); --danger: #d14343; --success: #16834f;
      --shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(15, 18, 40, .14);
      --logo-bg: #0b0c13; --logo-tile: #fff; --logo-ring: transparent; --logo-plane: #f0a22e; --logo-fold: #c27a10;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --bg: #1c1c1f; --fg: #f4f4f5; --muted: #a1a1aa; --faint: #71717a; --line: #2e2e33; --soft: #27272b; --hover: #26262a;
        --accent: #7d92ff; --accent-hover: #93a5ff; --accent-soft: rgba(125, 146, 255, .14); --danger: #ff7a7a; --success: #4ade80;
        --shadow: 0 1px 2px rgba(0,0,0,.3), 0 16px 40px rgba(0,0,0,.45);
        --logo-ring: rgba(255, 255, 255, .16);
      }
    }
    svg { display: block; flex: none; }
    .logo-bg { fill: var(--logo-bg); stroke: var(--logo-ring); } .logo-tile { fill: var(--logo-tile); }
    .logo-plane { fill: var(--logo-plane); stroke: var(--logo-plane); } .logo-fold { fill: none; stroke: var(--logo-fold); }

    /* 悬浮按钮：可拖动，松手后吸附到最近的左右边缘 */
    /* 按钮本身就是标志：暗灰圆角方块，与浏览器标签页图标一致 */
    .fab { position: fixed; width: 44px; height: 44px; padding: 0; border-radius: 10px; border: 0; background: transparent;
      box-shadow: var(--shadow); display: grid; place-items: center; cursor: pointer; pointer-events: auto; touch-action: none;
      user-select: none; z-index: 2147483646; transition: top .2s ease, left .2s ease, transform .15s ease, opacity .15s; }
    .fab:hover { transform: scale(1.06); }
    .fab.dragging { transition: none; transform: scale(1.1); cursor: grabbing; }
    .fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .badge { position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center;
      box-shadow: 0 0 0 2px var(--bg); }

    /* 面板 */
    .panel { position: fixed; width: min(380px, calc(100vw - 24px)); display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
      pointer-events: auto; z-index: 2147483647; animation: rise .16s ease-out; }
    /* 只做位移不改透明度：动画被节流或暂停时面板仍然完整可见 */
    @keyframes rise { from { transform: translateY(6px); } }
    header { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--line); flex: none; }
    header .title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .back { margin-left: -6px; }
    .body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px; display: grid; gap: 20px; align-content: start;
      grid-template-columns: minmax(0, 1fr); }
    footer { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
    footer .spacer { flex: 1; }
    footer .site { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 12px; }
    footer .site span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* 按钮 */
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
    button:disabled { opacity: .45; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); flex: none; }
    .icon-btn:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
    .icon-btn.accent { color: var(--accent); }
    .icon-btn.accent:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent); }
    .btn { height: 34px; padding: 0 14px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-weight: 500; white-space: nowrap; background: var(--soft); }
    .btn:hover:not(:disabled) { background: var(--line); }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn.ghost { background: none; color: var(--muted); }
    .btn.ghost:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
    .btn.block { flex: 1; }
    .text-btn { color: var(--muted); font-size: 12px; padding: 2px 4px; border-radius: 6px; }
    .text-btn:hover { color: var(--fg); background: var(--soft); }

    /* 当前页面（X 帖子 / YouTube 视频） */
    .hero { display: grid; gap: 12px; padding: 14px; border-radius: 12px; background: var(--soft); }
    .hero-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .hero-mark { width: 36px; height: 36px; border-radius: 10px; background: var(--bg); color: var(--accent); display: grid; place-items: center; flex: none; }
    .hero-text { min-width: 0; }
    .hero-text strong { display: block; font-weight: 600; }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .actions .icon-btn { background: var(--bg); width: 34px; height: 34px; border-radius: 9px; }

    /* 资源列表 */
    .section { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
    .section-head { display: flex; align-items: center; gap: 8px; }
    .section-head h2 { font-size: 13px; font-weight: 600; }
    .count { color: var(--faint); font-weight: 400; margin-left: 4px; }
    .section-head .spacer { flex: 1; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; color: var(--muted); background: none; border: 1px solid var(--line); }
    .chip:hover { color: var(--fg); }
    .chip[aria-pressed=true] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
    .list { display: grid; grid-template-columns: minmax(0, 1fr); margin: 0 -8px; }
    .item { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px; border-radius: 10px; }
    .item:hover { background: var(--hover); }
    .tile { width: 40px; height: 40px; border-radius: 9px; background: var(--soft); color: var(--muted); display: grid; place-items: center;
      flex: none; overflow: hidden; }
    .tile img { width: 100%; height: 100%; object-fit: cover; }
    .meta { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-actions { display: flex; gap: 2px; flex: none; }
    .item-actions:empty { display: none; }
    .empty { display: grid; justify-items: center; gap: 10px; padding: 28px 12px; color: var(--muted); text-align: center; font-size: 12px; }
    .empty .tile { width: 44px; height: 44px; border-radius: 12px; }
    .empty.loading .tile svg { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* 选择文件 */
    .pick { cursor: pointer; }
    .check { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--faint); display: grid; place-items: center; flex: none;
      color: transparent; transition: background .12s, border-color .12s; }
    .pick input { position: absolute; opacity: 0; pointer-events: none; }
    .pick input:checked + .check { background: var(--accent); border-color: var(--accent); color: #fff; }
    .pick input:focus-visible + .check { outline: 2px solid var(--accent); outline-offset: 2px; }
    .warn { color: #b7791f; font-size: 12px; white-space: normal; }

    /* 多选 */
    .item.selectable { cursor: pointer; }
    .item.is-selected { background: var(--accent-soft); }
    .item.is-selected:hover { background: var(--accent-soft); }
    .item.is-sent:not(.is-selected) .name { color: var(--muted); }
    .sent-tag { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 4px; background: var(--soft); color: var(--success);
      font-size: 11px; font-weight: 500; line-height: 16px; vertical-align: 1px; }
    .check.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .select-all { display: flex; align-items: center; gap: 8px; cursor: pointer; border-radius: 6px; }
    .select-all:focus-visible, .item.selectable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    footer .selection { font-size: 12px; color: var(--muted); }

    /* 批量发送 */
    .batch-banner { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 12px; background: var(--accent-soft);
      color: var(--fg); text-align: left; }
    .batch-banner .meta { gap: 6px; }
    .batch-banner > svg { color: var(--muted); }
    .overview { display: grid; gap: 8px; }
    .overview-line { display: flex; align-items: baseline; gap: 8px; }
    .overview-line strong { font-size: 15px; font-weight: 600; }
    .progress { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; position: relative; }
    .progress > span { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--accent); transition: width .3s ease; }
    .progress.done > span { background: var(--success); }
    .progress.indeterminate > span { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { from { left: -35%; } to { left: 100%; } }
    .state { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .state.ok { color: var(--success); }
    .state.err { color: var(--danger); white-space: normal; overflow-wrap: anywhere; }
    .state.run { color: var(--accent); }
    .batch-item .meta { gap: 4px; }

    /* 表单 */
    .field { display: grid; gap: 6px; }
    .label { font-size: 12px; font-weight: 500; color: var(--muted); }
    input[type=text], input[type=password], input[type=url] { width: 100%; height: 36px; font: inherit; color: inherit;
      background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 0 11px; }
    input::placeholder { color: var(--faint); }
    input[type=text]:focus, input[type=password]:focus, input[type=url]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    textarea { width: 100%; min-height: 96px; resize: vertical; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: inherit;
      background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; }
    textarea::placeholder { color: var(--faint); font-family: inherit; }
    textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border-radius: 9px; background: var(--soft); }
    .segmented button { height: 30px; border-radius: 7px; font-size: 12px; color: var(--muted); }
    .segmented button[aria-checked=true] { background: var(--bg); color: var(--fg); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .switch-row { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
    .switch-row .meta { gap: 1px; }
    .switch-row .name { white-space: normal; }
    .switch-row .sub { white-space: normal; }
    .switch { position: relative; width: 34px; height: 20px; flex: none; margin-top: 1px; }
    .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 10px; background: var(--line); transition: background .15s; pointer-events: none; }
    .switch span::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
    .switch input:checked + span { background: var(--accent); }
    .switch input:checked + span::after { transform: translateX(14px); }
    .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
    .group { display: grid; gap: 14px; }
    .divider { height: 1px; background: var(--line); }
    .status { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: flex-start; }
    .status.ok { color: var(--success); }
    .status.error, .error { color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }

    /* 完成 */
    .result { display: grid; justify-items: center; gap: 8px; padding: 16px 0 4px; text-align: center; }
    .result .tile { width: 48px; height: 48px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); }
    .result strong { font-size: 15px; font-weight: 600; }
    .result .sub { white-space: normal; overflow-wrap: anywhere; }

    .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
      background: var(--fg); color: var(--bg); font-size: 12px; box-shadow: var(--shadow); z-index: 2147483647; pointer-events: none;
      max-width: 80vw; animation: rise .16s ease-out; }
  `;

  // 线条图标（24×24，描边）。YouTube 等站点启用了 Trusted Types，禁止给 innerHTML 赋字符串，所有节点都用 DOM API 创建。
  const ICONS = {
    settings: ["M20 7h-9", "M14 17H5", ["circle", { cx: 17, cy: 17, r: 3 }], ["circle", { cx: 7, cy: 7, r: 3 }]],
    close: ["M18 6 6 18", "m6 6 12 12"],
    back: ["m15 18-6-6 6-6"],
    link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
    terminal: ["m4 17 6-6-6-6", "M12 19h8"],
    send: ["M12 13v8", "m8 17 4-4 4 4", "M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"],
    video: [["rect", { x: 2, y: 4, width: 20, height: 16, rx: 3 }], "m10 9 5 3-5 3z"],
    audio: ["M9 18V5l12-2v13", ["circle", { cx: 6, cy: 18, r: 3 }], ["circle", { cx: 18, cy: 16, r: 3 }]],
    stream: ["M12 12H3", "M16 6H3", "M12 18H3", "m16 12 5 3-5 3v-6Z"],
    file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
    image: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["circle", { cx: 9, cy: 9, r: 2 }], "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
    check: ["M20 6 9 17l-5-5"],
    minus: ["M5 12h14"],
    retry: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
    chevron: ["m9 18 6-6-6-6"],
    search: [["circle", { cx: 11, cy: 11, r: 8 }], "m21 21-4.3-4.3"],
    loader: ["M21 12a9 9 0 1 1-6.22-8.56"],
    alert: [["circle", { cx: 12, cy: 12, r: 10 }], "M12 8v4", "M12 16h.01"],
    download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
    globe: [["circle", { cx: 12, cy: 12, r: 10 }], "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
    x: ["M4 4l16 16", "M20 4 4 20"],
    youtube: [["rect", { x: 2, y: 5, width: 20, height: 14, rx: 4 }], "m10 9 5 3-5 3z"],
  };
  const TYPE_ICON = { video: "video", audio: "audio", stream: "stream", image: "image", file: "file" };

  function svg(name, size = 16, width = 1.8) {
    const ns = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) node.setAttribute(key, value);
    for (const part of ICONS[name]) {
      const [tag, attrs] = typeof part === "string" ? ["path", { d: part }] : part;
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
      node.append(child);
    }
    return node;
  }
  const icon = () => svg("download", 20, 2);

  /** Tessera 标志，几何与 web/src/ui.tsx 的 LogoMark 一致，颜色取自 --logo-* 令牌。 */
  function logo(size = 24) {
    const ns = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 32 32", width: size, height: size, "aria-hidden": "true" })) node.setAttribute(key, value);
    for (const [tag, attrs] of [
      ["rect", { class: "logo-bg", x: .5, y: .5, width: 31, height: 31, rx: 7.5 }],
      ["rect", { class: "logo-tile", x: 5, y: 5, width: 10, height: 10, rx: 2.4 }],
      ["rect", { class: "logo-tile", x: 5, y: 17, width: 10, height: 10, rx: 2.4, "fill-opacity": .6 }],
      ["rect", { class: "logo-tile", x: 17, y: 17, width: 10, height: 10, rx: 2.4, "fill-opacity": .32 }],
      ["polygon", { class: "logo-plane", points: "18.2,6.2 25.8,6.2 25.8,13.8", "stroke-width": 2.4, "stroke-linejoin": "round" }],
      ["path", { class: "logo-fold", d: "M25.1 6.9 22.2 9.8", "stroke-width": 1.1, "stroke-linecap": "round" }],
    ]) {
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
      node.append(child);
    }
    return node;
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

  const iconButton = (name, title, onclick, extra = "") =>
    h("button", { type: "button", className: `icon-btn ${extra}`, title, "aria-label": title, onclick }, svg(name));

  /** 当前页面就是配置的 Tessera 站点时不显示悬浮按钮、不嗅探（Tampermonkey 菜单里的「设置」仍可用）。 */
  function onTessera() {
    try { return Boolean(settings().server) && new URL(settings().server).origin === location.origin; } catch { return false; }
  }

  let host, shadow, root, fab, badge, panel, toastTimer;
  let active = false;  // 当前网站是否启用（嗅探、悬浮按钮、站内按钮）

  function mount() {
    if (host || !document.documentElement) return;
    host = h("div", { id: "tessera-grabber" });
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "closed" });
    root = h("div", { className: "root" });
    shadow.append(h("style", {}, STYLE), root);
    badge = h("span", { className: "badge", hidden: true });
    fab = h("button", { type: "button", className: "fab", title: "Tessera 资源抓取（可拖动）", "aria-label": "Tessera 资源抓取" }, logo(44), badge);
    enableDrag(fab);
    root.append(fab);
    document.documentElement.append(host);
    placeFab();
    refreshFab();
    listeners.add(refreshFab);
    document.addEventListener("fullscreenchange", refreshFab);
    window.addEventListener("resize", () => { placeFab(); placePanel(); });
  }

  // ----- 悬浮按钮拖动 -----

  const FAB = 44, EDGE = 16;
  /** 位置保存为 { side: "left" | "right", y: 顶部占视口高度的比例 }，跨站点共用。 */
  const fabPosition = () => ({ side: "right", y: null, ...GM_getValue("fabPosition", {}) });

  function placeFab() {
    if (!fab) return;
    const { side, y } = fabPosition();
    const top = y == null ? innerHeight - FAB - 24 : y * innerHeight;
    fab.style.top = `${Math.min(Math.max(top, EDGE), innerHeight - FAB - EDGE)}px`;
    fab.style.left = `${side === "left" ? EDGE : innerWidth - FAB - EDGE}px`;
  }

  function enableDrag(button) {
    let start = null, moved = false;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      moved = false;
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", event => {
      if (!start) return;
      if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      moved = true;
      button.classList.add("dragging");
      button.style.left = `${Math.min(Math.max(event.clientX - start.dx, 4), innerWidth - FAB - 4)}px`;
      button.style.top = `${Math.min(Math.max(event.clientY - start.dy, 4), innerHeight - FAB - 4)}px`;
      placePanel();
    });
    const finish = event => {
      if (!start) return;
      start = null;
      button.classList.remove("dragging");
      if (!moved) return;
      const rect = button.getBoundingClientRect();
      GM_setValue("fabPosition", { side: rect.left + FAB / 2 < innerWidth / 2 ? "left" : "right", y: rect.top / innerHeight });
      placeFab();
      setTimeout(placePanel, 210);
      // 拖动结束时浏览器可能紧接着派发 click：短时间内吞掉它，避免松手就打开面板。
      button.addEventListener("click", swallow, { once: true, capture: true });
      setTimeout(() => button.removeEventListener("click", swallow, { capture: true }), 300);
    };
    const swallow = event => { event.stopImmediatePropagation(); event.preventDefault(); };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
    button.addEventListener("click", () => toggle());
  }

  /** 面板贴着悬浮按钮所在的一侧；按钮在下半屏时向上展开，否则向下展开。 */
  function placePanel() {
    if (!panel) return;
    const fabRect = fab && fab.style.display !== "none" ? fab.getBoundingClientRect() : null;
    const left = fabRect ? fabRect.left + FAB / 2 < innerWidth / 2 : false;
    Object.assign(panel.style, { left: "", right: "", top: "", bottom: "" });
    panel.style[left ? "left" : "right"] = `${Math.max(12, EDGE)}px`;
    if (!fabRect) {
      panel.style.bottom = "20px";
      panel.style.maxHeight = `${Math.min(640, innerHeight - 40)}px`;
    } else if (fabRect.top + FAB / 2 > innerHeight / 2) {
      panel.style.bottom = `${innerHeight - fabRect.top + 12}px`;
      panel.style.maxHeight = `${Math.min(640, fabRect.top - 24)}px`;
    } else {
      panel.style.top = `${fabRect.bottom + 12}px`;
      panel.style.maxHeight = `${Math.min(640, innerHeight - fabRect.bottom - 24)}px`;
    }
  }

  function refreshFab() {
    if (!fab) return;
    const count = [...items.values()].filter(item => item.type !== "image").length;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    fab.style.display = !settings().fab || !active || document.fullscreenElement ? "none" : "";
  }

  function toast(message) {
    if (!root) return;
    root.querySelector(".toast")?.remove();
    const node = h("div", { className: "toast", role: "status" }, message);
    root.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 2200);
  }

  function copy(text, message = "已复制") {
    GM_setClipboard(text, "text");
    toast(message);
  }

  function close() {
    panel?.remove();
    panel = null;
    listeners.delete(renderListIfOpen);
    clearInterval(liveTimer);
    liveTimer = 0;
  }

  window.addEventListener("pointerup", () => { pointerDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; }, true);

  // ESC：有上一级时返回，主面板时关闭。只处理焦点在面板内或页面上没有焦点的情况，不打断网页输入框；全屏时交给网页。
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !panel || document.fullscreenElement || event.isComposing) return;
    const focus = document.activeElement;
    if (event.target !== host && focus && focus !== document.body && focus !== document.documentElement) return;
    event.preventDefault();
    event.stopPropagation();
    panel.back ? panel.back() : close();
  }, true);

  function toggle(context) {
    if (panel && !context) return close();
    open(context);
  }

  /** 面板骨架：标题栏 + 可滚动内容 + 可选的底部操作栏。 */
  function frame(title, body, { back, footer } = {}) {
    close();
    const header = h("header", {},
      back ? iconButton("back", "返回", back, "back") : logo(20),
      h("span", { className: "title" }, title),
      back ? null : iconButton("settings", "设置", () => openSettings(() => open(currentContext))),
      iconButton("close", "关闭", close));
    panel = h("div", { className: "panel", role: "dialog", "aria-label": title }, header, h("div", { className: "body" }, body),
      footer ? h("footer", {}, footer) : null);
    panel.back = back;
    panel.addEventListener("pointerdown", () => { pointerDown = true; });
    root.append(panel);
    placePanel();
    return panel;
  }

  const emptyState = (name, text, loading = false) =>
    h("div", { className: `empty${loading ? " loading" : ""}` }, h("span", { className: "tile" }, svg(name, 20)), h("span", {}, text));

  // ----- 主面板 -----

  let filter = "all";
  let currentContext = null;
  let liveTimer = 0;
  let pointerDown = false;  // 按住鼠标期间不改动列表，避免点击落空
  const rowCache = new Map();
  const selected = new Set();  // 已勾选的资源地址，跨筛选保留
  const BATCH_LIMIT = 50;

  /** context: { platform, label, url, scope } —— scope 为 X 帖子元素时只列出这条帖子的图片。 */
  function open(context) {
    mount();
    currentContext = context || platformOf(location.href);
    frame("Tessera", [
      h("div", { className: "banner-host" }),
      currentContext ? platformCard(currentContext) : null,
      h("div", { className: "section list-host" }),
    ], { footer: [] });
    panel.dataset.view = "main";
    renderBanner();
    renderList();
    listeners.add(renderListIfOpen);
    // 懒加载的图片和换页后的 DOM 不会触发网络嗅探，打开期间定时重新扫描，有变化才更新。
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (panel && panel.dataset.view === "main") renderList(); }, 1500);
  }

  /** 底部栏：有勾选时显示批量操作，否则显示当前网站与「在此网站隐藏」。 */
  function renderFooter() {
    const footer = panel && panel.dataset.view === "main" && panel.querySelector("footer");
    if (!footer) return;
    if (selected.size) {
      footer.hidden = false;
      footer.replaceChildren(
        h("span", { className: "selection" }, `已选 ${selected.size} 项`),
        h("button", { type: "button", className: "text-btn", onclick: () => { selected.clear(); renderList(); } }, "清除"),
        h("span", { className: "spacer" }),
        h("button", { type: "button", className: "btn primary", onclick: () => startBatch([...selected]) }, svg("send"), `发送 ${selected.size} 项`));
      return;
    }
    footer.hidden = onTessera();
    footer.replaceChildren(
      h("span", { className: "site", title: location.hostname }, svg("globe", 14), h("span", {}, currentSite())),
      h("span", { className: "spacer" }),
      h("button", { type: "button", className: "text-btn", onclick: () => setSiteEnabled(!active) }, active ? "在此网站隐藏" : "在此网站启用"));
  }

  function platformCard(context) {
    const youtube = context.platform === "youtube";
    return h("div", { className: "hero" },
      h("div", { className: "hero-head" },
        h("span", { className: "hero-mark" }, svg(youtube ? "youtube" : "x", 18)),
        h("div", { className: "hero-text" }, h("strong", {}, context.label), h("div", { className: "sub" }, context.url))),
      h("div", { className: "actions" },
        h("button", { type: "button", className: "btn primary block", onclick: () => send(context.url, context.platform) }, svg("send"), "发送到 Tessera"),
        iconButton("link", "复制链接", () => copy(context.url, "已复制链接")),
        iconButton("terminal", "复制 curl 命令", async () => copy(await curlFor(context.url), "已复制 curl 命令"))),
      h("p", { className: "hint" }, youtube
        ? "YouTube 的媒体地址带签名且分段，无法直接下载；发送后由服务器解析并选择清晰度。"
        : "视频由服务器解析；图片可以在下方直接复制原图地址。"));
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

  /** 让 parent 的子节点依次等于 nodes：已在正确位置的节点不移动，新节点插入，多余的移除。 */
  function syncChildren(parent, nodes) {
    nodes.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }

  /**
   * 列表原地更新：首次创建骨架，之后只改计数、勾选状态并按地址复用行元素。
   * 定时刷新和新资源到达都会调用这里，整块替换会让正在进行的点击落空、滚动位置跳动。
   */
  function renderList() {
    const target = panel && panel.querySelector(".list-host");
    if (!target || pointerDown) return;
    const all = collect();
    const sent = new Set(sentList());
    const urls = new Set(all.map(item => item.url));
    for (const url of selected) if (!urls.has(url)) selected.delete(url);
    for (const url of rowCache.keys()) if (!urls.has(url)) rowCache.delete(url);
    const counts = all.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {});
    const types = Object.keys(TYPE_LABEL).filter(type => counts[type]);
    if (filter !== "all" && !counts[filter]) filter = "all";
    const shown = all.filter(item => filter === "all" || item.type === filter);
    // 全选只作用于当前筛选下显示、且尚未发送过的资源。
    const pickable = shown.filter(item => !sent.has(item.url));
    const picked = pickable.filter(item => selected.has(item.url)).length;
    const allPicked = pickable.length > 0 && picked === pickable.length;

    if (!target.parts) {
      const parts = {
        check: h("span", { className: "check" }),
        count: h("span", { className: "count" }),
        clear: h("button", { type: "button", className: "text-btn", onclick: () => { items.clear(); refreshFab(); renderList(); } }, "清空"),
        chips: h("div", { className: "chips" }),
        list: h("div", { className: "list" }),
        empty: emptyState("search", "还没有发现可下载的资源。播放视频或滚动加载图片后再打开。"),
      };
      parts.selectAll = h("span", { className: "select-all", role: "checkbox", tabindex: "0", onclick: () => target.toggleAll(),
        onkeydown: event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); target.toggleAll(); } } }, parts.check);
      target.replaceChildren(
        h("div", { className: "section-head" }, parts.selectAll, h("h2", {}, "页面资源", parts.count), h("span", { className: "spacer" }), parts.clear),
        parts.chips, parts.list, parts.empty);
      target.parts = parts;
    }
    const parts = target.parts;
    target.toggleAll = () => {
      if (allPicked) pickable.forEach(item => selected.delete(item.url));
      else {
        for (const item of pickable) {
          if (selected.size >= BATCH_LIMIT) { toast(`一次最多选择 ${BATCH_LIMIT} 项`); break; }
          selected.add(item.url);
        }
      }
      renderList();
    };
    parts.count.textContent = String(all.length);
    parts.clear.hidden = !all.length || Boolean(currentContext && currentContext.scope);
    parts.selectAll.hidden = !pickable.length;
    parts.selectAll.title = allPicked ? "取消全选" : sent.size && shown.length > pickable.length ? "全选（跳过已发送）" : "全选";
    parts.selectAll.setAttribute("aria-checked", allPicked ? "true" : picked ? "mixed" : "false");
    parts.check.className = `check${picked ? " on" : ""}`;
    parts.check.replaceChildren(svg(allPicked ? "check" : "minus", 12, 3));
    // 筛选标签只在种类或数量变化时重建。
    const chipKey = types.length > 1 ? `${filter}|${types.map(type => `${type}:${counts[type]}`).join(",")}` : "";
    if (parts.chips.dataset.key !== chipKey) {
      parts.chips.dataset.key = chipKey;
      const chip = (value, label) => h("button", { type: "button", className: "chip", "aria-pressed": String(filter === value),
        onclick: () => { filter = value; renderList(); } }, label);
      parts.chips.replaceChildren(...(chipKey ? [chip("all", "全部"), ...types.map(type => chip(type, `${TYPE_LABEL[type]} ${counts[type]}`))] : []));
    }
    parts.chips.hidden = !chipKey;
    syncChildren(parts.list, shown.map(item => {
      let node = rowCache.get(item.url);
      if (!node) rowCache.set(item.url, node = row(item));
      syncRow(node, item, sent.has(item.url));
      return node;
    }));
    parts.list.hidden = !shown.length;
    parts.empty.hidden = Boolean(shown.length);
    renderFooter();
  }

  function row(item) {
    let domain = "";
    try { domain = new URL(item.url).hostname.replace(/^www\./, ""); } catch { /* 忽略 */ }
    const tile = h("span", { className: "tile" }, item.type === "image"
      ? h("img", { src: item.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : svg(TYPE_ICON[item.type], 18));
    // 勾选状态在点击时读取，行元素会被复用。
    const toggle = () => {
      if (selected.has(item.url)) selected.delete(item.url);
      else if (selected.size >= BATCH_LIMIT) return toast(`一次最多选择 ${BATCH_LIMIT} 项`);
      else selected.add(item.url);
      renderList();
    };
    const node = h("div", { className: "item selectable", role: "checkbox", tabindex: "0",
      // 点击行的空白处切换勾选；行尾的按钮各自处理，不触发勾选。
      onclick: event => { if (!event.target.closest("button")) toggle(); },
      onkeydown: event => { if ((event.key === " " || event.key === "Enter") && event.target === event.currentTarget) { event.preventDefault(); toggle(); } } },
      h("span", { className: "check" }, svg("check", 12, 3)),
      tile,
      h("div", { className: "meta" },
        h("div", { className: "name", title: item.url }, fileName(item.url)),
        h("div", { className: "sub" }, h("span", { className: "sent-tag" }, "已发送"), h("span", { className: "sub-text" }, [TYPE_LABEL[item.type], domain].filter(Boolean).join(" · ")))),
      h("div", { className: "item-actions" },
        iconButton("link", "复制链接", () => copy(item.url, "已复制链接")),
        iconButton("terminal", "复制 curl 命令", async () => copy(await curlFor(item.url), "已复制 curl 命令")),
        iconButton("send", "发送到 Tessera", () => send(item.url, null), "accent")));
    return node;
  }

  function syncRow(node, item, sent) {
    const on = selected.has(item.url);
    node.classList.toggle("is-selected", on);
    node.classList.toggle("is-sent", sent);
    node.setAttribute("aria-checked", String(on));
    node.querySelector(".check").classList.toggle("on", on);
    node.querySelector(".sent-tag").hidden = !sent;
  }

  // ----- 发送到 Tessera -----

  async function send(url, platform) {
    mount();
    if (!settings().server || !settings().key) {
      toast("请先填写 Tessera 地址和访问密钥");
      return openSettings(() => open(currentContext));
    }
    const back = () => open(currentContext);
    frame("发送到 Tessera", emptyState("loader", platform === "youtube" ? "服务器正在解析视频格式，可能需要十几秒…" : "正在解析…", true), { back });
    let parsed;
    try {
      // 平台链接单独传 Cookie；文件直链把 Cookie 写进 curl 命令，与网页「下载任务」的规则一致。
      const payload = platform
        ? { input: url, cookies: settings().cookies ? await cookieHeader(url) : "" }
        : { input: await curlFor(url) };
      parsed = await api("POST", "/api/v1/downloads/parse", payload);
    } catch (error) {
      return frame("发送到 Tessera", h("div", { className: "empty" }, h("span", { className: "tile" }, svg("alert", 20)),
        h("span", { className: "error" }, error.message)), {
        back,
        footer: [h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: back }, "返回"),
          h("button", { type: "button", className: "btn primary", onclick: () => send(url, platform) }, "重试")],
      });
    }
    renderCandidates(parsed.candidates || [], back, url);
  }

  function formatSize(size) {
    if (!size) return "大小未知";
    const units = ["B", "KB", "MB", "GB"];
    let value = size, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function renderCandidates(candidates, back, url) {
    // 同一组（同一视频的不同清晰度）默认只选第一个；X 帖子的每张图、每个视频各自一组。
    const seen = new Set();
    const checks = candidates.map(candidate => {
      const first = !seen.has(candidate.group);
      seen.add(candidate.group);
      return h("input", { type: "checkbox", checked: first });
    });
    const destination = h("input", { type: "text", value: settings().destination, placeholder: "根目录" });
    const error = h("div", { className: "error", hidden: true });
    const submit = h("button", { type: "button", className: "btn primary" }, "开始下载");
    const refresh = () => {
      const count = checks.filter(check => check.checked).length;
      submit.disabled = count === 0;
      submit.textContent = count > 1 ? `下载 ${count} 个文件` : "开始下载";
    };
    checks.forEach(check => check.addEventListener("change", refresh));
    refresh();
    submit.addEventListener("click", async () => {
      const chosen = candidates.filter((_, index) => checks[index].checked);
      if (!chosen.length) return;
      submit.disabled = true;
      error.hidden = true;
      const folder = destination.value.trim().replace(/^\/+/, "");
      try {
        const result = await api("POST", "/api/v1/downloads", {
          items: chosen.map(item => ({ ticket: item.ticket, name: item.name })),
          ...(folder ? { destination: folder } : {}),
        });
        saveSettings({ destination: folder });
        markSent([url]);
        done(result.tasks || [], back);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
      }
    });
    const rows = candidates.map((candidate, index) => h("label", { className: "item pick" }, checks[index],
      h("span", { className: "check" }, svg("check", 12, 3)),
      h("div", { className: "meta" },
        h("div", { className: "name", title: candidate.name }, candidate.name),
        h("div", { className: "sub" }, [candidate.variant, formatSize(candidate.size)].filter(Boolean).join(" · ")),
        (candidate.warnings || []).map(text => h("div", { className: "warn" }, text)))));
    frame("选择要下载的文件", [
      rows.length ? h("div", { className: "list" }, rows) : emptyState("file", "没有可下载的文件"),
      h("label", { className: "field" }, h("span", { className: "label" }, "保存到目录"), destination),
      error,
    ], { back, footer: [h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: back }, "取消"), submit] });
  }

  function done(tasks, back) {
    const link = settings().server.replace(/\/+$/, "") + "/?view=downloads";
    frame("发送到 Tessera", h("div", { className: "result" },
      h("span", { className: "tile" }, svg("check", 22, 2.4)),
      h("strong", {}, `已添加 ${tasks.length} 个下载任务`),
      h("div", { className: "sub" }, tasks.slice(0, 3).map(task => task.key).join("、") + (tasks.length > 3 ? ` 等 ${tasks.length} 项` : ""))), {
      back,
      footer: [h("button", { type: "button", className: "btn ghost", onclick: back }, "返回"), h("span", { className: "spacer" }),
        h("button", { type: "button", className: "btn primary", onclick: () => GM_openInTab(link, { active: true }) }, "查看下载任务")],
    });
  }

  // ----- 批量发送 -----

  /**
   * 批次在页面内存中保存：关闭面板后继续解析、创建任务并轮询进度，重新打开时主面板顶部显示入口。
   * entry.state：waiting → parsing → creating → submitted（之后看 entry.tasks 的服务端状态）或 error。
   */
  let batch = null;
  const TERMINAL = ["completed", "failed", "stopped"];
  const PHASE = { resolving: "解析媒体…", downloading: "下载中", merging: "合并中…", saving: "保存中…" };

  function startBatch(urls) {
    if (!settings().server || !settings().key) {
      toast("请先填写 Tessera 地址和访问密钥");
      return openSettings(() => open(currentContext));
    }
    if (batch && batch.started && !batchDone()) return toast("上一批还在发送，请等待完成后再发送新的一批");
    // 按资源列表的显示顺序发送，而不是勾选的先后顺序。
    const listed = collect();
    const known = new Map(listed.map(item => [item.url, item]));
    const wanted = new Set(urls);
    const ordered = [...listed.map(item => item.url).filter(url => wanted.has(url)), ...urls.filter(url => !known.has(url))];
    batch = { started: false, destination: settings().destination,
      entries: ordered.slice(0, BATCH_LIMIT).map(url => ({ url, type: known.get(url)?.type || "file", state: "waiting", error: "", tasks: [] })) };
    openBatch();
  }

  const entryActive = entry => ["parsing", "creating"].includes(entry.state)
    || entry.state === "waiting" && batch.started
    || entry.state === "submitted" && entry.tasks.some(task => !TERMINAL.includes(task.status));
  const entryOk = entry => entry.state === "submitted" && entry.tasks.length > 0 && entry.tasks.every(task => task.status === "completed");
  const entryFailed = entry => entry.state === "error" || entry.state === "submitted" && entry.tasks.some(task => task.status === "failed" || task.status === "stopped");
  const batchDone = () => !batch || batch.started && !batch.entries.some(entryActive);

  async function runBatch() {
    batch.started = true;
    selected.clear();
    batch.destination = batch.destination.trim().replace(/^\/+/, "");
    saveSettings({ destination: batch.destination });
    const current = batch;
    const queue = current.entries.filter(entry => entry.state === "waiting");
    // 服务端同时最多解析 2 个，这里同样两路并行，避免请求排队超时。
    const worker = async () => { while (queue.length && batch === current) await sendEntry(queue.shift()); };
    updateBatch();
    await Promise.all([worker(), worker()]);
  }

  async function sendEntry(entry) {
    entry.state = "parsing"; entry.error = ""; entry.tasks = [];
    updateBatch();
    try {
      const parsed = await api("POST", "/api/v1/downloads/parse", { input: await curlFor(entry.url) });
      const candidates = parsed.candidates || [];
      if (!candidates.length) throw new Error("没有可下载的文件");
      // 每组只取第一个候选（例如 M3U8 的第一个清晰度），与单个发送的默认选择一致。
      const groups = new Set();
      const chosen = candidates.filter(candidate => !groups.has(candidate.group) && groups.add(candidate.group));
      entry.state = "creating";
      updateBatch();
      const result = await api("POST", "/api/v1/downloads", {
        items: chosen.map(candidate => ({ ticket: candidate.ticket, name: candidate.name })),
        ...(batch.destination ? { destination: batch.destination } : {}),
      });
      entry.tasks = result.tasks || [];
      entry.state = "submitted";
      markSent([entry.url]);
    } catch (error) {
      entry.state = "error";
      entry.error = error.message;
      markSent([entry.url], false);
    }
    updateBatch();
    schedulePoll();
  }

  function retryEntries(entries) {
    for (const entry of entries) { entry.state = "waiting"; entry.error = ""; entry.tasks = []; }
    void runBatch();
  }

  let pollTimer = 0;
  function schedulePoll(delay = 1500) {
    if (!pollTimer) pollTimer = setTimeout(poll, delay);
  }
  async function poll() {
    pollTimer = 0;
    if (!batch) return;
    const ids = batch.entries.flatMap(entry => entry.tasks.filter(task => !TERMINAL.includes(task.status)).map(task => task.id));
    if (ids.length) {
      try {
        const { tasks } = await api("GET", `/api/v1/downloads?ids=${ids.join(",")}`);
        const fresh = new Map(tasks.map(task => [task.id, task]));
        for (const entry of batch.entries) entry.tasks = entry.tasks.map(task => fresh.get(task.id) || task);
        // 下载失败或被停止的资源不算已发送，下次全选时重新包含。
        markSent(batch.entries.filter(entry => entry.state === "submitted" && entry.tasks.some(task => task.status === "failed" || task.status === "stopped")).map(entry => entry.url), false);
      } catch { /* 网络抖动：下一轮再试 */ }
      updateBatch();
    }
    if (batch && batch.entries.some(entryActive)) schedulePoll(2000);
  }

  function updateBatch() {
    if (!panel) return;
    if (panel.dataset.view === "batch") renderBatch();
    else if (panel.dataset.view === "main") renderBanner();
  }

  function batchSummary() {
    const total = batch.entries.length;
    const ok = batch.entries.filter(entryOk).length;
    const failed = batch.entries.filter(entryFailed).length;
    return { total, ok, failed, finished: batchDone() };
  }

  /** 主面板顶部的批次入口：只创建一次，之后原地更新文字和进度，避免轮询时替换节点吞掉点击。 */
  function renderBanner() {
    const target = panel && panel.querySelector(".banner-host");
    if (!target) return;
    target.hidden = !batch || !batch.started;
    if (target.hidden) return target.replaceChildren();
    let button = target.querySelector(".batch-banner");
    if (!button) {
      button = h("button", { type: "button", className: "batch-banner", onclick: openBatch },
        h("div", { className: "meta" }, h("div", { className: "name" }), h("div", { className: "progress" }, h("span"))), svg("chevron"));
      target.replaceChildren(button);
    }
    const { total, ok, failed, finished } = batchSummary();
    button.querySelector(".name").textContent = finished
      ? `批量发送已结束 · 成功 ${ok}${failed ? `，失败 ${failed}` : ""}` : `正在批量发送 · 已完成 ${ok} / ${total}`;
    button.querySelector(".progress").className = `progress${finished && !failed ? " done" : ""}`;
    button.querySelector(".progress > span").style.width = `${total ? (ok + failed) / total * 100 : 0}%`;
  }

  function openBatch() {
    if (!batch) return open(currentContext);
    frame("批量发送", h("div", { className: "batch-host", style: "display:grid;gap:16px;grid-template-columns:minmax(0,1fr)" }),
      { back: () => open(currentContext), footer: [] });
    panel.dataset.view = "batch";
    renderBatch();
  }

  /** 一个条目的状态文字、语气与进度（0–1，null 为不确定进度，undefined 为不显示）。 */
  function entryStatus(entry) {
    if (entry.state === "waiting") return { text: batch.started ? "等待中" : TYPE_LABEL[entry.type] };
    if (entry.state === "parsing") return { text: "解析中…", tone: "run", progress: null };
    if (entry.state === "creating") return { text: "提交任务…", tone: "run", progress: null };
    if (entry.state === "error") return { text: entry.error || "发送失败", tone: "err" };
    const task = entry.tasks.find(item => !TERMINAL.includes(item.status)) || entry.tasks.find(item => item.status !== "completed") || entry.tasks[0];
    if (!task) return { text: "已提交" };
    const more = entry.tasks.length > 1 ? `（${entry.tasks.length} 个文件）` : "";
    if (task.status === "completed") return { text: `已完成 · ${formatSize(task.stored_bytes || task.size)}${more}`, tone: "ok", progress: 1 };
    if (task.status === "failed") return { text: task.error || "下载失败", tone: "err" };
    if (task.status === "stopped") return { text: task.error ? `已停止：${task.error}` : "已停止", tone: "err" };
    if (task.status === "queued") return { text: "排队中", progress: 0 };
    if (task.status === "interrupted") return { text: task.error || "等待重试", tone: "run", progress: null };
    const fraction = task.segments_total ? task.segments_done / task.segments_total
      : task.size ? Math.min(1, (task.received || 0) / task.size) : null;
    const parts = [PHASE[task.phase] || "下载中"];
    if (task.phase === "downloading" || !task.phase) {
      if (fraction != null) parts.push(`${Math.floor(fraction * 100)}%`);
      else if (task.received) parts.push(formatSize(task.received));
      if (task.speed) parts.push(`${formatSize(task.speed)}/s`);
    }
    return { text: parts.join(" · ") + more, tone: "run", progress: task.phase === "downloading" || !task.phase ? fraction : null };
  }

  /** 批次条目的行：每个条目只创建一次，轮询时原地更新状态，保证重试按钮可以点到。 */
  function batchRow(entry) {
    if (!entry.row) {
      const tile = h("span", { className: "tile" });
      const state = h("div", { className: "state" });
      const bar = h("div", { className: "progress" }, h("span"));
      const action = h("span", { className: "item-actions" });
      entry.row = { node: h("div", { className: "item batch-item" }, tile,
        h("div", { className: "meta" }, h("div", { className: "name", title: entry.url }, fileName(entry.url)), state, bar), action),
        tile, state, bar, action, icon: "", retry: false };
    }
    const { tile, state, bar, action } = entry.row;
    const status = entryStatus(entry);
    const iconName = entryOk(entry) ? "check" : TYPE_ICON[entry.type] || "file";
    if (entry.row.icon !== iconName) { tile.replaceChildren(svg(iconName, 18)); entry.row.icon = iconName; }
    state.className = `state${status.tone ? " " + status.tone : ""}`;
    state.textContent = status.text;
    bar.hidden = status.progress === undefined || entry.state === "waiting";
    bar.className = `progress${status.progress == null ? " indeterminate" : ""}${status.tone === "ok" ? " done" : ""}`;
    bar.firstChild.style.width = `${(status.progress || 0) * 100}%`;
    const retry = batch.started && entryFailed(entry) && !entryActive(entry);
    if (entry.row.retry !== retry) {
      action.replaceChildren(...(retry ? [iconButton("retry", "重试", () => retryEntries([entry]))] : []));
      entry.row.retry = retry;
    }
    return entry.row.node;
  }

  function renderBatch() {
    const target = panel && panel.dataset.view === "batch" && panel.querySelector(".batch-host");
    const footer = panel && panel.querySelector("footer");
    if (!target || !batch) return;
    const rows = batch.entries.map(batchRow);
    if (!batch.started) {
      // 发送前确认保存目录；先写回 batch，避免列表刷新时丢失输入。
      const destination = h("input", { type: "text", value: batch.destination, placeholder: "留空保存到根目录",
        oninput: event => { batch.destination = event.target.value; } });
      target.replaceChildren(
        h("label", { className: "field" }, h("span", { className: "label" }, "保存到目录"), destination),
        h("div", { className: "section" }, h("div", { className: "section-head" }, h("h2", {}, "待发送", h("span", { className: "count" }, String(batch.entries.length)))),
          h("div", { className: "list" }, rows)),
        h("p", { className: "hint" }, "每项由服务器解析后自动选择第一个可用格式；需要挑选清晰度的视频请单独发送。"));
      footer.replaceChildren(h("span", { className: "spacer" }),
        h("button", { type: "button", className: "btn ghost", onclick: () => { batch = null; open(currentContext); } }, "取消"),
        h("button", { type: "button", className: "btn primary", onclick: () => void runBatch() }, svg("send"), `开始发送 ${batch.entries.length} 项`));
      footer.dataset.mode = "draft";
      return;
    }
    const { total, ok, failed, finished } = batchSummary();
    let overview = target.querySelector(".overview");
    if (!overview || target.querySelector(".field")) {
      overview = h("div", { className: "overview" },
        h("div", { className: "overview-line" }, h("strong"), h("span", { className: "sub" })), h("div", { className: "progress" }, h("span")));
      target.replaceChildren(overview, h("div", { className: "list" }, rows));
    }
    overview.querySelector("strong").textContent = finished ? "发送结束" : "正在发送";
    overview.querySelector(".sub").textContent = `成功 ${ok} / ${total}${failed ? ` · 失败 ${failed}` : ""}${batch.destination ? ` · 保存到 ${batch.destination}` : ""}`;
    overview.querySelector(".progress").className = `progress${finished && !failed ? " done" : ""}`;
    overview.querySelector(".progress > span").style.width = `${total ? (ok + failed) / total * 100 : 0}%`;
    // 底部按钮只在形态变化时重建（运行中／结束、有无失败项），轮询不会替换正在点击的按钮。
    const failedEntries = batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry));
    const mode = `${finished ? "done" : "run"}:${failedEntries.length > 0}`;
    if (footer.dataset.mode === mode) return;
    footer.dataset.mode = mode;
    const link = settings().server.replace(/\/+$/, "") + "/?view=downloads";
    footer.replaceChildren(...[
      h("button", { type: "button", className: "btn ghost", onclick: () => GM_openInTab(link, { active: true }) }, "查看下载任务"),
      h("span", { className: "spacer" }),
      failedEntries.length ? h("button", { type: "button", className: "btn", onclick: () => retryEntries(batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry))) }, "重试失败项") : null,
      finished
        ? h("button", { type: "button", className: "btn primary", onclick: () => { batch = null; open(currentContext); } }, "完成")
        : h("button", { type: "button", className: "btn primary", onclick: close, title: "关闭面板，发送和进度跟踪在后台继续" }, "后台运行"),
    ].filter(Boolean));
  }

  // ----- 设置 -----

  function toggleRow(input, title, description) {
    return h("label", { className: "switch-row" },
      h("div", { className: "meta" }, h("div", { className: "name" }, title), h("div", { className: "sub" }, description)),
      h("span", { className: "switch" }, input, h("span")));
  }

  function openSettings(back) {
    mount();
    const current = settings();
    const server = h("input", { type: "url", value: current.server, placeholder: "https://drive.example.com" });
    const key = h("input", { type: "password", value: current.key, placeholder: "AccessKeyId:Secret", autocomplete: "off" });
    const destination = h("input", { type: "text", value: current.destination, placeholder: "留空保存到根目录" });
    const cookies = h("input", { type: "checkbox", checked: current.cookies });
    const showFab = h("input", { type: "checkbox", checked: current.fab });
    // 显示范围：两种模式各自保留一份列表，切换模式时把输入框内容换成对应列表。
    const lists = { exclude: [...current.excludeSites], include: [...current.includeSites] };
    let mode = current.siteMode === "include" ? "include" : "exclude";
    const sites = h("textarea", { spellcheck: "false", rows: 4 });
    const scopeHint = h("span", { className: "hint" });
    const parseSites = () => sites.value.split(/[\n,，]+/).map(line => line.trim()).filter(Boolean);
    const modeButtons = {};
    const showMode = () => {
      sites.value = lists[mode].join("\n");
      sites.placeholder = mode === "include" ? "每行一个域名，例如\nx.com\nyoutube.com" : "每行一个域名，例如\nexample.com";
      scopeHint.textContent = mode === "include"
        ? "只在这些网站上显示，同时包含它们的子域名。列表为空时所有网站都不显示。"
        : "在这些网站上不显示，同时包含它们的子域名。Tessera 站点始终不显示。";
      for (const [value, button] of Object.entries(modeButtons)) button.setAttribute("aria-checked", String(value === mode));
    };
    for (const [value, label] of [["exclude", "所有网站，排除以下"], ["include", "仅以下网站"]]) {
      modeButtons[value] = h("button", { type: "button", role: "radio", onclick: () => { lists[mode] = parseSites(); mode = value; showMode(); } }, label);
    }
    showMode();
    const status = h("div", { className: "status", hidden: true });
    const say = (text, tone = "") => {
      status.hidden = false; status.className = `status ${tone}`; status.textContent = text;
      if (tone === "error") status.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const read = () => {
      lists[mode] = parseSites();
      return { server: server.value.trim().replace(/\/+$/, ""), key: key.value.trim(),
        destination: destination.value.trim().replace(/^\/+/, ""), cookies: cookies.checked, fab: showFab.checked,
        siteMode: mode, excludeSites: lists.exclude, includeSites: lists.include };
    };
    const validate = value => {
      const invalid = [...value.excludeSites, ...value.includeSites].find(rule => !normalizeSite(rule));
      if (invalid) return `无法识别的网站：${invalid}（请填写域名，例如 example.com）`;
      if (value.server && !/^https?:\/\/[^/\s]+/.test(value.server)) return "Tessera 地址应以 http:// 或 https:// 开头";
      if (value.key && !/^[^:\s]+:\S+$/.test(value.key)) return "访问密钥格式应为 AccessKeyId:Secret";
      return "";
    };
    const test = h("button", { type: "button", className: "btn ghost" }, "测试连接");
    test.addEventListener("click", async () => {
      const value = read();
      const problem = validate(value);
      if (problem) return say(problem, "error");
      saveSettings(value);
      say("正在连接…");
      try {
        const me = await api("GET", "/api/v1/me");
        const writable = (me.grants || []).filter(grant => grant.perms === "rw").map(grant => `${grant.bucket}/${grant.prefix}`);
        if (!me.owner) say("密钥不属于任何用户，不能创建离线下载", "error");
        else if (!writable.length) say(`已连接到用户 ${me.owner}，但密钥没有写入权限`, "error");
        else say(`连接成功 · 用户 ${me.owner}`, "ok");
      } catch (error) {
        say(error.message, "error");
      }
    });
    const save = h("button", { type: "button", className: "btn primary" }, "保存");
    save.addEventListener("click", () => {
      const value = read();
      const problem = validate(value);
      if (problem) return say(problem, "error");
      // 规则统一保存为去重后的域名。
      const clean = list => [...new Set(list.map(normalizeSite))];
      saveSettings({ ...value, excludeSites: clean(value.excludeSites), includeSites: clean(value.includeSites) });
      applySiteState();
      refreshFab();
      toast("设置已保存");
      back ? back() : close();
    });
    frame("设置", [
      h("div", { className: "group" },
        h("label", { className: "field" }, h("span", { className: "label" }, "Tessera 地址"), server),
        h("label", { className: "field" }, h("span", { className: "label" }, "访问密钥"), key,
          h("span", { className: "hint" }, "在 Tessera「访问密钥」页面新建，按 Access Key ID:Secret 填写。只保存在 Tampermonkey 中。")),
        h("label", { className: "field" }, h("span", { className: "label" }, "默认保存目录"), destination),
        status),
      h("div", { className: "divider" }),
      h("div", { className: "group" },
        toggleRow(cookies, "附带登录 Cookie", "下载需要登录才能看的内容时使用"),
        toggleRow(showFab, "显示悬浮按钮", "可拖动到屏幕左右两侧，也可以只用 Tampermonkey 菜单打开")),
      h("div", { className: "divider" }),
      h("div", { className: "group" },
        h("div", { className: "field" }, h("span", { className: "label" }, "显示范围"),
          h("div", { className: "segmented", role: "radiogroup", "aria-label": "显示范围" }, Object.values(modeButtons)),
          sites, scopeHint)),
    ], { back: back || close, footer: [test, h("span", { className: "spacer" }), save] });
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

  let domObserver = null;
  function watchDom() {
    if (domObserver) return;
    const host = location.hostname.replace(/^(www|mobile|m)\./, "");
    const decorate = host === "x.com" || host === "twitter.com" ? decorateX : host === "youtube.com" ? decorateYouTube : null;
    if (!decorate) return;
    let pending = false;
    domObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; if (active) decorate(); }, 400);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    decorate();
  }

  // ---------- 单页应用换页 ----------

  // X、YouTube 换页不刷新文档：地址变化时丢掉上一页的资源，主面板切换到新页面。X 的图片查看器（/photo/1）不算换页。
  const pageKey = href => { try { const url = new URL(href); return url.origin + url.pathname.replace(/\/(photo|video)\/\d+\/?$/, "") + url.search; } catch { return href; } };
  let currentPage = pageKey(location.href);
  let navTimer = 0;
  function checkNavigation(slack = 0) {
    const key = pageKey(location.href);
    if (!active || key === currentPage) return;
    currentPage = key;
    // 轮询发现得晚，保留刚到达的资源（大概率属于新页面）。
    const cutoff = Date.now() - slack;
    for (const [url, item] of items) if (item.time < cutoff) items.delete(url);
    refreshFab();
    if (!panel || panel.dataset.view !== "main" || (currentContext && currentContext.scope)) return;
    const next = platformOf(location.href);
    if ((next && next.url) !== (currentContext && currentContext.url)) open(next);
    else renderList();
  }
  function watchNavigation() {
    if (navTimer) return;
    currentPage = pageKey(location.href);
    const navigation = page.navigation || window.navigation;
    try { navigation?.addEventListener("navigatesuccess", () => checkNavigation()); } catch { /* 不支持 Navigation API */ }
    window.addEventListener("popstate", () => checkNavigation());
    navTimer = setInterval(() => checkNavigation(1500), 1000);
  }

  // ---------- 启动 ----------

  const whenReady = fn => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn();

  function activate() {
    if (active) return;
    active = true;
    observeNetwork();
    watchNavigation();
    whenReady(() => { if (!active) return; mount(); watchDom(); refreshFab(); });
  }

  /** 停用后立即生效：断开嗅探与站内按钮观察、移除已加的按钮并清空列表，不需要刷新页面。 */
  function deactivate() {
    active = false;
    networkObserver?.disconnect();
    networkObserver = null;
    domObserver?.disconnect();
    domObserver = null;
    document.querySelectorAll("[data-tessera-grabber]").forEach(node => node.remove());
    items.clear();
    close();
    refreshFab();
  }

  let siteMenu = null;
  function updateMenu() {
    if (siteMenu != null && typeof GM_unregisterMenuCommand === "function") GM_unregisterMenuCommand(siteMenu);
    if (onTessera()) return;
    siteMenu = GM_registerMenuCommand(active ? `在 ${currentSite()} 上停用` : `在 ${currentSite()} 上启用`, () => setSiteEnabled(!active));
  }

  function applySiteState() {
    siteEnabled() ? activate() : deactivate();
    updateMenu();
  }

  GM_registerMenuCommand("打开资源面板", () => open());
  GM_registerMenuCommand("设置", () => openSettings());
  // Tessera 站点和被排除的网站上不嗅探、不加按钮；需要时仍可从 Tampermonkey 菜单打开面板或设置。
  applySiteState();
})();
