// ==UserScript==
// @name         Tessera 资源抓取
// @namespace    https://github.com/yangshoulai/tgdrive
// @version      0.14.1
// @description  在 X、YouTube 和其他网页上复制资源地址与 curl 命令，发送到 Tessera 离线下载，或在浏览器下载后上传
// @author       yangshoulai
// @license      MIT
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
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.openInTab
// @grant        GM.setClipboard
// @grant        GM.xmlHttpRequest
// @inject-into  content
// @connect      *
// ==/UserScript==

/*
 * 三处入口：右下角悬浮按钮（所有网页）、X 帖子操作栏、YouTube 播放页操作栏。
 * - 资源嗅探：PerformanceObserver 记录页面加载过的视频、音频、M3U8 和常见文件；图片从 DOM 中按尺寸挑选。
 * - 复制：链接，或带 User-Agent、Referer、Cookie 的 curl 命令（Cookie 经 GM_cookie 读取，包含 HttpOnly）。
 * - 保存到 Tessera（两种方式共用一个确认页：保存位置含私密空间、逐项修改文件名）：
 *   服务器下载：调用 /api/v1/downloads/parse 与 /api/v1/downloads，由服务器下载；
 *   本地下载：当前浏览器读取直链资源，再通过 PUT /api/v1/files 上传；单文件最多 64 MiB，不支持流媒体列表。
 *   私密空间：服务器下载转交解析结果、本地下载把文件 postMessage 给新打开的 Tessera 页面，由用户在那里解锁并确认。
 * - 发给文件助手：把当前已渲染页面的结构快照（图片候选与分页链接，不含正文）postMessage 给新打开的 Tessera 页面，
 *   可以逐页暂存后一起发送；由用户在 Tessera 的助手对话框里点击发送，不经过访问密钥。
 * Cookie 只放进你复制的命令或发给你自己配置的 Tessera 服务器，不发往其他地方。
 * 兼容两类脚本管理器：Tampermonkey／Violentmonkey 的同步 GM_* API，以及 iOS Userscripts（Safari）只提供的异步 GM.* API；
 * 后者没有 GM_cookie 和菜单命令，启动前先把存储读入内存，未启用的网站保留一个淡化的悬浮按钮作为入口。
 */
(function () {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const MAX_ITEMS = 150;

  // ---------- 脚本管理器兼容层 ----------

  // Tampermonkey／Violentmonkey 提供同步 GM_*；iOS Userscripts 只有异步 GM.*（以及 GM_xmlhttpRequest），没有 GM_cookie 与菜单命令。
  // 存储统一走内存缓存：异步环境启动前一次读入，写入先改缓存再异步保存，其余代码保持同步读写。
  const GMA = typeof GM !== "undefined" ? GM : null;
  const SYNC_STORE = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  const HAS_MENU = typeof GM_registerMenuCommand === "function";
  const STORE_KEYS = ["settings", "sent", "fabPosition", "assistant-pages"];
  const cache = new Map();
  const gm = {
    get(key, fallback) {
      if (SYNC_STORE) return GM_getValue(key, fallback);
      return cache.has(key) ? cache.get(key) : fallback;
    },
    set(key, value) {
      if (SYNC_STORE) return GM_setValue(key, value);
      cache.set(key, value);
      const done = value === null || value === undefined ? GMA?.deleteValue?.(key) : GMA?.setValue?.(key, value);
      Promise.resolve(done).catch(() => { /* 保存失败时本页仍使用内存中的值 */ });
    },
    /** 异步存储读入内存；切回标签页时重新读取，拿到其他标签页写入的已发送记录与设置。 */
    async load() {
      if (SYNC_STORE || !GMA?.getValue) return;
      await Promise.all(STORE_KEYS.map(async key => {
        try {
          const value = await GMA.getValue(key);
          if (value === undefined) cache.delete(key); else cache.set(key, value);
        } catch { /* 读取失败沿用默认值 */ }
      }));
    },
    openTab(url) {
      if (typeof GM_openInTab === "function") return GM_openInTab(url, { active: true });
      if (GMA?.openInTab) return void Promise.resolve(GMA.openInTab(url, false)).catch(() => window.open(url, "_blank"));
      window.open(url, "_blank");
    },
    copy(text) {
      if (typeof GM_setClipboard === "function") return GM_setClipboard(text, "text");
      if (GMA?.setClipboard) return void Promise.resolve(GMA.setClipboard(text, "text/plain")).catch(() => navigator.clipboard?.writeText(text));
      navigator.clipboard?.writeText(text);
    },
    /** 返回带 abort() 的请求句柄；GM.xmlHttpRequest 返回的 Promise 本身也带 abort。 */
    xhr(details) {
      if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(details);
      if (GMA?.xmlHttpRequest) {
        const request = GMA.xmlHttpRequest(details);
        Promise.resolve(request).catch(() => { /* 结果经回调处理 */ });
        return request;
      }
      throw new Error("当前脚本管理器不支持跨域请求，请使用 Tampermonkey、Violentmonkey 或 Userscripts");
    },
    menu(label, fn) { return HAS_MENU ? GM_registerMenuCommand(label, fn) : null; },
    unmenu(id) { if (id != null && typeof GM_unregisterMenuCommand === "function") GM_unregisterMenuCommand(id); },
  };

  // ---------- 设置 ----------

  // siteMode：exclude = 所有网站，排除 excludeSites；include = 只在 includeSites 中的网站。两份列表分开保存，切换模式互不覆盖。
  // destination 以 / 结尾（空串为根目录）；destinationPrivate 为 true 时保存到私密空间（需在 Tessera 页面解锁确认）。
  const DEFAULTS = { server: "", key: "", destination: "", destinationPrivate: false, cookies: true, fab: true, view: "list", siteMode: "exclude", excludeSites: [], includeSites: [] };
  const settings = () => ({ ...DEFAULTS, ...gm.get("settings", {}) });
  const saveSettings = value => gm.set("settings", { ...settings(), ...value });

  // ---------- 已发送记录 ----------

  // 发送成功的资源地址持久保存（跨页面、跨标签页），列表里标「已发送」，全选与批量发送时自动跳过；任务失败时移除。
  const SENT_LIMIT = 1000;
  const sentList = () => gm.get("sent", []);
  const isSent = url => sentList().includes(url);
  function markSent(urls, sent = true) {
    const set = new Set(urls);
    const rest = sentList().filter(url => !set.has(url));
    gm.set("sent", sent ? [...rest, ...set].slice(-SENT_LIMIT) : rest);
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
    toast(enabled ? `已在 ${currentSite()} 上启用` : HAS_MENU ? `已在 ${currentSite()} 上隐藏，可从脚本管理器菜单恢复` : `已在 ${currentSite()} 上隐藏，点淡化的悬浮按钮可重新启用`);
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
  // 已探测的资源一直累积（上限 MAX_ITEMS，超出时丢弃最早的），只有手动「清空」或刷新页面才清除：
  // 弹窗、标签页切换后旧图片离开 DOM，或单页应用换了地址，之前探测到的资源都要保留，方便一次发送多处的文件。
  const items = new Map();
  const clearedUrls = new Set();  // 已手动清空的地址，避免 DOM 扫描或重复请求立即补回
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

  // 资源大小与图片尺寸按地址缓存（单条帖子等范围视图里的条目不进入 items，也能显示）。
  const resourceMeta = new Map();
  function noteMeta(url, size, dims) {
    const meta = resourceMeta.get(url) || {};
    let changed = false;
    if (size > 0 && !meta.size) { meta.size = size; changed = true; }
    if (dims && dims[0] && dims[1] && !meta.dims) { meta.dims = dims; changed = true; }
    if (changed) { resourceMeta.set(url, meta); syncMeta(url); }
  }
  /** 资源计时里的大小只用于图片与文件：音视频通常按范围请求，计时只反映已加载的一段。跨域且未允许计时的资源为 0。 */
  const timingSize = (entry, type) => type === "image" || type === "file" ? entry.decodedBodySize || entry.encodedBodySize || 0 : 0;

  function remember(url, type, extra = {}) {
    if (url) noteMeta(url, extra.size, extra.dims);
    if (!url || items.has(url) || clearedUrls.has(url)) return false;
    items.set(url, { url, type, time: Date.now(), ...extra });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    return true;
  }
  function addItem(url, type, extra = {}) {
    if (remember(url, type, extra)) listeners.forEach(fn => fn());
  }

  let networkObserver = null;
  function observeNetwork() {
    const Observer = page.PerformanceObserver || window.PerformanceObserver;
    if (!Observer || networkObserver) return;
    try {
      networkObserver = new Observer(list => {
        for (const entry of list.getEntries()) {
          const type = classify(entry.name, entry.initiatorType);
          if (type) addItem(entry.name, type, { source: "网络", size: timingSize(entry, type) });
        }
      });
      networkObserver.observe({ type: "resource", buffered: true });
    } catch { networkObserver = null; /* 浏览器不支持资源计时 */ }
    // Safari 扩展的内容脚本环境里观察器可能收不到页面资源：同时定时读取资源计时列表补齐（重复地址由 remember 去重）。
    if (!resourcePoll) resourcePoll = setInterval(pollResources, 2000);
    pollResources();
  }
  let resourcePoll = null, resourceIndex = 0;
  function pollResources() {
    const timeline = page.performance || window.performance;
    let entries;
    try { entries = timeline?.getEntriesByType?.("resource") || []; } catch { return; }
    if (entries.length < resourceIndex) resourceIndex = 0; // 页面清空了资源缓冲区
    let changed = false;
    for (const entry of entries.slice(resourceIndex)) {
      const type = classify(entry.name, entry.initiatorType);
      if (type && remember(entry.name, type, { source: "网络", size: timingSize(entry, type) })) changed = true;
    }
    resourceIndex = entries.length;
    if (changed) listeners.forEach(fn => fn());
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
      if (big || twitter) {
        const url = upgradeImage(src);
        // 升级成原图的地址尺寸未知，等列表里的预览图加载后再记录。
        found.push({ url, type: "image", source: "页面", dims: url === src ? [img.naturalWidth, img.naturalHeight] : null });
      }
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
        try { resolve(new URL(url).hostname === location.hostname ? document.cookie : ""); }
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

  const stoppedError = () => new DOMException("已停止", "AbortError");

  /** 同时收束完成、超时与取消；关闭面板不取消请求，只有显式停止才中止。 */
  function gmRequest(details, signal, maxBytes) {
    if (signal?.aborted) return Promise.reject(stoppedError());
    return new Promise((resolve, reject) => {
      let request, timer, settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(response);
      };
      const abort = () => { finish(stoppedError()); request?.abort(); };
      const limit = response => {
        if (!maxBytes) return false;
        const length = Number((response.responseHeaders || "").match(/^content-length:\s*(\d+)/im)?.[1]) || response.total || 0;
        if (length <= maxBytes && (response.loaded || 0) <= maxBytes) return false;
        finish(new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地"));
        request?.abort();
        return true;
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (details.timeout) timer = setTimeout(() => {
        finish(new Error(details.timeoutMessage || "浏览器请求超时"));
        request?.abort();
      }, details.timeout);
      try {
        request = gm.xhr({ ...details,
          onreadystatechange: response => { limit(response); },
          onprogress: response => { if (!settled && !limit(response)) details.onprogress?.(response); },
          upload: details.upload ? { onprogress: response => { if (!settled) details.upload.onprogress?.(response); } } : undefined,
          onload: response => { if (!limit(response)) finish(null, response); },
          onabort: () => finish(stoppedError()),
          onerror: () => finish(new Error(details.errorMessage || "浏览器请求失败")),
          ontimeout: () => finish(new Error(details.timeoutMessage || "浏览器请求超时")),
        });
      } catch (error) { finish(error); }
    });
  }

  async function api(method, path, body, { config = settings(), signal, contentType = "application/json", binary = false, onprogress,
    timeout = method === "PUT" ? 600000 : 180000 } = {}) {
    const { server, key } = config;
    if (!server || !key) return Promise.reject(new Error("请先在设置中填写 Tessera 地址和访问密钥"));
    const response = await gmRequest({
      method, url: server.replace(/\/+$/, "") + path, anonymous: true, timeout,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": contentType },
      data: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      upload: onprogress ? { onprogress } : undefined,
      errorMessage: "无法连接 Tessera，请检查地址，并在 Tampermonkey 提示时允许访问该域名",
      timeoutMessage: "请求 Tessera 超时",
    }, signal);
    let data = null;
    try { data = response.responseText ? JSON.parse(response.responseText) : null; } catch { /* 非 JSON */ }
    if (response.status >= 200 && response.status < 300) return data;
    throw new Error(data?.error?.message || `Tessera 返回 HTTP ${response.status}`);
  }

  // ---------- 浏览器下载 ----------

  const BROWSER_MAX_BYTES = 64 * 1024 * 1024;
  const BROWSER_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif", "image/bmp": ".bmp", "image/svg+xml": ".svg",
    "image/tiff": ".tiff", "image/x-icon": ".ico", "image/jxl": ".jxl", "image/jp2": ".jp2",
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "application/pdf": ".pdf" };
  const browserEligible = item => item.type !== "stream" && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(item.url);
  const sourceHeader = (headers, name) => (headers || "").match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1].trim() || "";
  const sourceError = (status, pageStatus, extension = false) => new Error(status === 401 || status === 403
    ? `${pageStatus ? `网页请求 HTTP ${pageStatus}，` : ""}来源拒绝${extension ? "扩展" : "网页"}请求（HTTP ${status}）。直接打开图片与脚本读取的权限可能不同；请先打开原图确认，仍失败时手动保存后上传`
    : `${extension ? "扩展" : "网页"}下载失败（HTTP ${status}）`);
  /** Cloudflare 人机验证只能在用户打开的页面里通过；后台请求遇到它时提示「打开验证」，通过后带上验证 Cookie 重试即可。 */
  const challengeError = () => Object.assign(new Error("来源启用了 Cloudflare 人机验证：点「打开验证」在新标签页完成验证后，再点重试"), { challenge: true });
  const isChallenge = (status, headers, prefix = "") => /^challenge$/i.test(sourceHeader(headers, "cf-mitigated"))
    || (status === 403 || status === 503) && /cloudflare/i.test(sourceHeader(headers, "server"))
      && /(?:Just a moment|cf-chl|challenge-platform|Attention Required)/i.test(prefix);
  // 与浏览器加载 <img>／媒体时的 Accept 一致，避免被当成脚本请求；User-Agent 保持浏览器自带的值（改写反而更像机器人）。
  const ACCEPT = { image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", video: "*/*", audio: "*/*" };

  async function validateBrowserFile(blob, type, contentType, mitigated) {
    if (!blob || typeof blob.slice !== "function" || !blob.size) throw new Error("来源未返回文件内容");
    if (blob.size > BROWSER_MAX_BYTES) throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地");
    const mime = (contentType || blob.type || "").split(";", 1)[0].trim().toLowerCase();
    const prefix = await blob.slice(0, 1024).text();
    if (mitigated === "challenge") throw challengeError();
    if (/(?:text\/html|application\/xhtml\+xml)/.test(mime)
      || /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)
      || /<title>\s*(?:Just a moment|Attention Required)[\s!|]/i.test(prefix)) {
      throw new Error("来源返回了登录、验证或拦截页面，未上传；请先在网页中完成验证后重试");
    }
    if (/mpegurl|dash\+xml/i.test(mime) || /^\s*#EXTM3U\b/.test(prefix)) throw new Error("流媒体列表请使用服务器下载");
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    const detected = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
      : ascii(0, 8) === "\x89PNG\r\n\x1a\n" ? "image/png"
      : /^GIF8[79]a$/.test(ascii(0, 6)) ? "image/gif"
      : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp"
      : ascii(0, 2) === "BM" ? "image/bmp"
      : ["II*\x00", "MM\x00*"].includes(ascii(0, 4)) ? "image/tiff"
      : ascii(0, 4) === "\x00\x00\x01\x00" ? "image/x-icon"
      : bytes[0] === 0xff && bytes[1] === 0x0a || ascii(4, 12) === "JXL \r\n\x87\n" ? "image/jxl"
      : ascii(4, 12) === "jP  \r\n\x87\n" ? "image/jp2"
      : ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, 12)) ? "image/avif"
      : ascii(4, 8) === "ftyp" && /heic|heix|hevc|hevx|mif1|msf1/.test(ascii(8, 12)) ? mime.startsWith("image/") ? mime : "image/heif"
      : /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(prefix) ? "image/svg+xml" : "";
    if (type === "image" && !detected) throw new Error("来源没有返回可识别的图片，未上传；请确认原图可以正常打开");
    return detected || mime || "application/octet-stream";
  }

  /** 图片优先尝试浏览器缓存；网页读取失败或返回 403 时，用扩展上下文与来源 Cookie 再请求一次。 */
  async function browserDownload(url, type, { signal, cookies, onprogress }) {
    if (!/^https?:\/\//i.test(url) || !browserEligible({ url, type })) throw new Error("浏览器上传只支持 HTTP(S) 文件直链，流媒体和平台视频请使用服务器下载");
    if (signal.aborted) throw stoppedError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
    try {
      const extensionDownload = async pageStatus => {
        if (controller.signal.aborted) throw stoppedError();
        const cookie = cookies ? await cookieHeader(url) : "";
        const source = await gmRequest({ method: "GET", url, responseType: "blob", timeout: 180000,
          anonymous: !cookies, cookie: cookie || undefined,
          headers: { Accept: ACCEPT[type] || "*/*", Referer: referer() },
          onprogress: event => onprogress(event.loaded || 0, event.lengthComputable ? event.total : null),
          errorMessage: "浏览器无法读取资源，请允许 Tampermonkey 访问来源域名，或手动保存后上传",
          timeoutMessage: "浏览器下载超时，请重试",
        }, controller.signal, BROWSER_MAX_BYTES);
        if (source.status < 200 || source.status >= 300) {
          const prefix = source.response && typeof source.response.slice === "function" ? await source.response.slice(0, 4096).text().catch(() => "") : "";
          if (isChallenge(source.status, source.responseHeaders, prefix)) throw challengeError();
          throw sourceError(source.status, pageStatus, true);
        }
        const mime = await validateBrowserFile(source.response, type, sourceHeader(source.responseHeaders, "content-type"), sourceHeader(source.responseHeaders, "cf-mitigated"));
        return { blob: source.response, mime };
      };
      let response;
      try { response = await page.fetch(url, { credentials: cookies ? "include" : "omit", signal: controller.signal,
        ...(type === "image" ? { cache: "force-cache" } : {}) }); }
      catch {
        if (controller.signal.aborted) throw stoppedError();
        return await extensionDownload();
      }
      if (response.status === 403) { await response.body?.cancel(); return await extensionDownload(403); }
      if (!response.ok) { await response.body?.cancel(); throw sourceError(response.status); }
      const total = Number(response.headers.get("content-length")) || null;
      if (total > BROWSER_MAX_BYTES) { await response.body?.cancel(); throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地"); }
      if (!response.body) throw new Error("浏览器无法读取文件内容，请使用最新版浏览器和 Tampermonkey");
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0, complete = false;
      try {
        while (true) {
          if (controller.signal.aborted) throw stoppedError();
          const { done, value } = await reader.read();
          if (done) { complete = true; break; }
          received += value.byteLength;
          if (received > BROWSER_MAX_BYTES) throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地");
          chunks.push(value);
          onprogress(received, total);
        }
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const blob = new Blob(chunks, { type: response.headers.get("content-type") || "" });
      const mime = await validateBrowserFile(blob, type, response.headers.get("content-type"), response.headers.get("cf-mitigated"));
      return { blob, mime };
    } catch (error) {
      if (timedOut) throw new Error("浏览器下载超时，请重试");
      if (signal.aborted) throw stoppedError();
      throw error.name === "TypeError" ? new Error("浏览器读取资源时连接中断，请重试") : error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  function defaultSaveName(url) {
    let name = fileName(url).replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().replace(/^\.+|\.+$/g, "").normalize("NFC") || "file";
    if (name === ".tgdrive") name = "file";
    while (new TextEncoder().encode(name).length > 220) name = [...name].slice(0, -1).join("");
    return name;
  }

  function saveNameProblem(value) {
    const name = String(value || "").trim().normalize("NFC");
    if (!name) return "请填写保存文件名";
    if (/[\\/\x00-\x1f\x7f]/.test(value)) return "文件名不能包含路径或控制字符";
    if ([".", "..", ".tgdrive"].includes(name) || name.endsWith(".")) return "请填写有效文件名，不能使用保留名称或以点号结尾";
    if (new TextEncoder().encode(name).length > 220) return "文件名不能超过 220 字节，请缩短名称";
    return "";
  }

  function uploadSaveName(entry, mime) {
    let name = (entry.name ?? defaultSaveName(entry.url)).trim().normalize("NFC");
    if (!/\.[^.\s]+$/.test(name)) name += BROWSER_EXTENSIONS[mime] || "";
    const problem = saveNameProblem(name);
    if (problem) throw new Error(problem);
    return name;
  }

  /** PUT 先写入自己的临时名，再以 skip 移到确认名，目录事务保证同名文件不会被覆盖。 */
  function browserTemporaryName() {
    const suffix = [...crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(16).padStart(8, "0")).join("");
    return `.tessera-upload-${suffix}`;
  }

  // ---------- 界面 ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }
    [hidden] { display: none !important; }
    .root {
      --bg: #ffffff; --fg: #15161d; --muted: #6b6d7a; --faint: #a3a5b1; --line: rgba(20, 22, 40, .08); --line-strong: rgba(20, 22, 40, .16);
      --soft: rgba(20, 22, 40, .045); --hover: rgba(20, 22, 40, .04);
      --accent: #4c5cf5; --accent-2: #8b5cf6; --accent-hover: #3f4fe6; --accent-soft: rgba(76, 92, 245, .1); --amber: #f0a22e;
      --danger: #e5484d; --success: #12a150;
      --grad: linear-gradient(135deg, #4c5cf5 0%, #7c5cf6 55%, #a855f7 100%);
      --glass: rgba(255, 255, 255, .9); --glass-line: rgba(255, 255, 255, .7);
      --text-md: 14px; --text-lg: 16px; --radius-lg: 10px; --radius-xl: 14px; --radius-panel: 20px;
      --shadow: 0 0 0 1px rgba(20, 22, 40, .06), 0 2px 6px rgba(20, 22, 40, .06), 0 24px 60px -12px rgba(30, 30, 80, .28);
      --glow: 0 6px 20px -6px rgba(92, 80, 246, .55);
      --logo-bg: #0b0c13; --logo-tile: #fff; --logo-ring: transparent; --logo-plane: #f0a22e; --logo-fold: #c27a10;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --bg: #16171f; --fg: #f2f3f7; --muted: #9a9cab; --faint: #6c6e7d; --line: rgba(255, 255, 255, .08); --line-strong: rgba(255, 255, 255, .16);
        --soft: rgba(255, 255, 255, .06); --hover: rgba(255, 255, 255, .05);
        --accent: #8c96ff; --accent-2: #b48cff; --accent-hover: #a3abff; --accent-soft: rgba(140, 150, 255, .16); --danger: #ff6b70; --success: #3ddc84;
        --glass: rgba(22, 23, 32, .9); --glass-line: rgba(255, 255, 255, .08);
        --shadow: 0 0 0 1px rgba(255, 255, 255, .06), 0 2px 6px rgba(0, 0, 0, .3), 0 28px 70px -12px rgba(0, 0, 0, .7);
        --glow: 0 6px 22px -6px rgba(140, 120, 255, .6);
        --logo-ring: rgba(255, 255, 255, .16);
      }
    }
    svg { display: block; flex: none; }
    .logo-bg { fill: var(--logo-bg); stroke: var(--logo-ring); } .logo-tile { fill: var(--logo-tile); }
    .logo-plane { fill: var(--logo-plane); stroke: var(--logo-plane); } .logo-fold { fill: none; stroke: var(--logo-fold); }

    /* 悬浮按钮：可拖动，松手后吸附到最近的左右边缘 */
    /* 小圆形底座内保留品牌标志，减少对网页内容的遮挡 */
    .fab { position: fixed; width: 36px; height: 36px; padding: 0; border-radius: 50%; border: 1px solid var(--logo-ring); background: var(--logo-bg);
      box-shadow: var(--shadow); display: grid; place-items: center; cursor: pointer; pointer-events: auto; touch-action: none;
      user-select: none; z-index: 2147483646; transition: top .2s ease, left .2s ease, transform .15s ease, opacity .15s; }
    .fab .logo-bg { fill: none; stroke: none; }
    .fab:hover { transform: scale(1.06); }
    .fab.dragging { transition: none; transform: scale(1.1); cursor: grabbing; }
    .fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .badge { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; line-height: 16px; text-align: center;
      box-shadow: 0 0 0 2px var(--bg); }

    /* 面板 */
    .panel { position: fixed; width: 480px; max-width: calc(100% - 24px); display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-panel); box-shadow: var(--shadow);
      pointer-events: auto; z-index: 2147483647; animation: rise .16s ease-out; }
    .panel.batch-panel { width: 560px; }
    .panel.is-sheet { width: auto; }
    .fab.is-dormant { opacity: .38; transform: scale(.82); }
    .fab.is-dormant:hover, .fab.is-dormant:focus-visible { opacity: 1; transform: none; }
    .fab.is-dormant .badge { display: none; }
    /* 只做位移不改透明度：动画被节流或暂停时面板仍然完整可见 */
    @keyframes rise { from { transform: translateY(6px); } }
    header { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 16px 0 24px; border-bottom: 1px solid var(--line); flex: none; }
    header .title { flex: 1; min-width: 0; font-size: var(--text-lg); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .back { margin-left: -6px; }
    .body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 24px; display: grid; gap: 20px; align-content: start;
      grid-template-columns: minmax(0, 1fr); }
    footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 24px; border-top: 1px solid var(--line); }
    footer .spacer { flex: 1; }
    .footer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 420px) { .footer-actions { flex-basis: 100%; justify-content: flex-end; } }
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
    .progress.failed > span { background: var(--danger); }
    .progress.indeterminate > span { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { from { left: -35%; } to { left: 100%; } }
    .state { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .state.ok { color: var(--success); }
    .state.err { color: var(--danger); white-space: normal; overflow-wrap: anywhere; }
    .state.run { color: var(--accent); }
    .batch-host { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); }
    .batch-list { margin: 0; gap: 2px; }
    .batch-item { align-items: flex-start; gap: 12px; min-height: 0; padding: 8px; }
    .batch-item:hover { background: var(--hover); }
    .batch-item > .item-actions { align-self: center; align-items: center; gap: 4px; }
    .batch-item .meta { gap: 3px; align-self: center; }
    .tile-wrap { position: relative; flex: none; }
    .tile-badge { position: absolute; right: -3px; bottom: -3px; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center;
      background: var(--success); color: #fff; box-shadow: 0 0 0 2px var(--bg); }
    .tile-badge[hidden] { display: none; }
    .batch-item .state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .batch-item .state.err { white-space: normal; }
    .progress.thin { height: 3px; margin-top: 3px; }
    /* 名称输入框与普通名称同一位置，看上去像可编辑的标题 */
    .name-input[type=text] { height: 30px; margin: -3px 0 -1px -8px; width: calc(100% + 8px); padding: 0 8px; border-color: transparent; border-radius: 7px;
      background: var(--soft); font-weight: 500; transition: border-color .15s, background .15s, box-shadow .15s; }
    .name-input[type=text]:hover:not(:disabled) { border-color: var(--line); background: var(--bg); }
    .name-input[type=text]:focus { border-color: var(--accent); background: var(--bg); }
    .name-input[type=text][aria-invalid=true] { border-color: var(--danger); background: var(--bg); }
    .name-input[type=text][aria-invalid=true]:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 12%, transparent); }
    .btn.small { height: 28px; padding: 0 10px; font-size: 12px; gap: 4px; border-radius: 7px; }
    .action-sep { width: 1px; height: 16px; margin: 0 4px; background: var(--line); align-self: center; }
    .variant { height: 24px; min-width: 0; max-width: min(180px, 100%); padding: 0 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
      color: var(--fg); font: inherit; font-size: 12px; }
    .variant:focus { outline: none; border-color: var(--accent); }
    .batch-item .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; white-space: normal; }
    .batch-item .warn { font-size: 12px; }
    .batch-host > .dest { min-height: 0; }
    .batch-note { display: flex; align-items: flex-start; gap: 8px; }
    .batch-note > svg { margin-top: 2px; }
    @media (max-width: 560px) {
      header { padding-left: 16px; padding-right: 12px; }
      .body { padding: 16px; }
      footer { padding: 12px 16px; }
      .name-input[type=text] { font-size: 16px; }
    }

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
    /* 保存位置：一行摘要 + 「更改」，选择器是覆盖在当前面板上的一层，不丢失面板里的勾选和改名 */
    .dest { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
    .dest .meta { gap: 1px; }
    .dest .label { font-size: 11px; }
    .dest .name { font-weight: 500; }
    .dest.private { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: var(--accent-soft); }
    /* 选择层覆盖在面板上，面板内容较少时撑高到能浏览目录的高度 */
    .panel.has-layer { min-height: min(440px, calc(100vh - 96px)); }
    .layer { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; background: var(--bg); animation: rise .14s ease-out; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 12px; color: var(--muted); }
    .crumbs button { height: 24px; max-width: 100%; padding: 0 6px; border-radius: 6px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .crumbs button:hover { background: var(--hover); color: var(--fg); }
    .crumbs button[aria-current] { color: var(--fg); font-weight: 600; }
    .folder-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 10px; border-radius: 8px; text-align: left; color: var(--fg); }
    .folder-row:hover { background: var(--hover); }
    .folder-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-row > svg { color: var(--muted); }
    .new-folder { display: flex; gap: 6px; }
    .new-folder input { flex: 1; min-width: 0; }
    .private-note { display: grid; gap: 10px; padding: 14px; border-radius: 10px; background: var(--soft); color: var(--muted); font-size: 12px; line-height: 1.6; }
    .private-note strong { color: var(--fg); font-size: 13px; }
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
    .actions-row { display: flex; flex-wrap: wrap; gap: 8px; }

    /* 完成 */
    .result { display: grid; justify-items: center; gap: 8px; padding: 16px 0 4px; text-align: center; }
    .result .tile { width: 48px; height: 48px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); }
    .result strong { font-size: 15px; font-weight: 600; }
    .result .sub { white-space: normal; overflow-wrap: anywhere; }

    .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
      background: var(--fg); color: var(--bg); font-size: 12px; box-shadow: var(--shadow); z-index: 2147483647; pointer-events: none;
      max-width: 80vw; animation: rise .16s ease-out; }

    /* ===== 视觉层：毛玻璃面板、品牌渐变与网格视图（覆盖上面的基础样式） ===== */
    .panel { background: var(--glass); border: 1px solid var(--glass-line); box-shadow: var(--shadow);
      -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
      animation: pop .22s cubic-bezier(.2, .9, .3, 1.2); transform-origin: bottom right; }
    /* 只做缩放位移不改透明度：动画被节流或暂停时面板仍然完整可见 */
    @keyframes pop { from { transform: translateY(8px) scale(.97); } }
    /* 顶部一抹品牌光晕 */
    .panel::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 120px; pointer-events: none; z-index: 0;
      background: radial-gradient(120% 90% at 0% 0%, rgba(124, 92, 246, .16), transparent 60%),
                  radial-gradient(80% 80% at 100% 0%, rgba(240, 162, 46, .12), transparent 60%); }
    .panel > * { position: relative; z-index: 1; }
    .panel > .layer { position: absolute; z-index: 3; }
    header { height: 60px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--line); gap: 12px; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; box-shadow: 0 6px 16px -6px rgba(11, 12, 19, .6); }
    .title-block { flex: 1; min-width: 0; display: grid; line-height: 1.25; }
    .title-block .title { font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .subtitle { font-size: 11px; color: var(--muted); letter-spacing: .02em; }
    .body { padding: 18px 18px 20px; gap: 16px; }
    footer { padding: 12px 18px; background: color-mix(in srgb, var(--bg) 40%, transparent); }
    @media (max-width: 560px) { header { padding-left: 14px; } .body { padding: 14px; } footer { padding: 12px 14px; } }

    /* 按钮：主按钮用品牌渐变与柔光 */
    .icon-btn { border-radius: 9px; transition: background .15s, color .15s, transform .15s; }
    .icon-btn:active:not(:disabled) { transform: scale(.92); }
    .btn { height: 34px; border-radius: 10px; transition: background .15s, box-shadow .2s, transform .15s, filter .15s; }
    .btn:active:not(:disabled) { transform: translateY(1px); }
    .btn.primary { background: var(--grad); box-shadow: var(--glow), inset 0 1px 0 rgba(255, 255, 255, .22); }
    .btn.primary:hover:not(:disabled) { background: var(--grad); filter: brightness(1.08) saturate(1.1); box-shadow: 0 10px 26px -6px rgba(92, 80, 246, .6), inset 0 1px 0 rgba(255, 255, 255, .25); }
    .icon-btn.accent { color: var(--accent); background: var(--accent-soft); }
    .icon-btn.accent:hover:not(:disabled), .item.is-selected .icon-btn.accent { color: #fff; background: var(--grad); box-shadow: var(--glow); }

    /* 悬浮按钮：深色底座 + 渐变光环，角标用品牌琥珀色 */
    .fab { width: 42px; height: 42px; border: 0; background: radial-gradient(circle at 30% 25%, #2a2c3d, #0b0c13 70%);
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .08), 0 8px 24px -6px rgba(11, 12, 19, .55), 0 0 0 4px rgba(124, 92, 246, 0); }
    .fab::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; padding: 2px; background: var(--grad); opacity: .0;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; transition: opacity .2s; }
    .fab:hover::after, .fab.has-items::after { opacity: 1; }
    .fab:hover { transform: scale(1.08); box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .1), 0 12px 30px -6px rgba(92, 80, 246, .55); }
    .badge { top: -3px; right: -3px; min-width: 18px; height: 18px; border-radius: 9px; line-height: 18px; background: var(--amber); color: #1a1205;
      box-shadow: 0 0 0 2px #0b0c13; z-index: 1; }

    /* 标签与筛选 */
    .chip { height: 28px; padding: 0 12px; border-radius: 14px; border: 0; background: var(--soft); transition: background .15s, color .15s; }
    .chip:hover { background: var(--line-strong); }
    .chip[aria-pressed=true] { background: var(--accent-soft); color: var(--accent); font-weight: 600; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
    .section-head h2 { font-size: 13px; font-weight: 650; }
    .check { border-radius: 6px; }
    .check.on, .pick input:checked + .check { background: var(--grad); border-color: transparent; }

    /* 资源行 */
    .list { margin: 0 -6px; gap: 2px; }
    .item { --row-bg: var(--bg); gap: 12px; min-height: 60px; padding: 8px 8px; border-radius: 12px; transition: background .15s; }
    .item:hover { background: var(--hover); }
    .item.is-selected, .item.is-selected:hover { background: var(--accent-soft); }
    .tile { width: 44px; height: 44px; border-radius: 11px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .tile img { transition: transform .3s ease; }
    .item:hover .tile img { transform: scale(1.06); }
    .name { font-weight: 550; }
    .sent-tag { background: color-mix(in srgb, var(--success) 14%, transparent); }
    .item-actions { align-items: center; }
    .secondary { display: flex; align-items: center; gap: 2px; }
    @media (hover: hover) {
      .item .secondary { max-width: 0; overflow: hidden; opacity: 0; transition: max-width .2s ease, opacity .15s ease; }
      .item:hover .secondary, .item:focus-within .secondary { max-width: 120px; opacity: 1; }
    }
    .view-toggle { width: 28px; height: 28px; }

    /* 网格视图：同一行元素变成缩略图卡片 */
    .list.grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
    .list.grid .item { position: relative; flex-direction: column; align-items: stretch; gap: 6px; min-height: 0; padding: 6px 6px 8px;
      background: var(--soft); }
    .list.grid .item:hover { background: var(--line); }
    .list.grid .item.is-selected { background: var(--accent-soft); box-shadow: inset 0 0 0 2px var(--accent); }
    .list.grid .tile { width: 100%; height: auto; aspect-ratio: 4 / 3; border-radius: 9px; }
    .list.grid .tile svg { width: 26px; height: 26px; }
    .list.grid .check { position: absolute; top: 12px; left: 12px; z-index: 1; background: rgba(255, 255, 255, .9); border-color: rgba(0, 0, 0, .25);
      opacity: 0; transition: opacity .15s; }
    .list.grid .item:hover .check, .list.grid .item.is-selected .check, .list.grid .item:focus-visible .check { opacity: 1; }
    .list.grid .check.on { background: var(--grad); border-color: transparent; }
    .list.grid .meta { padding: 0 2px; }
    .list.grid .name { font-size: 12px; }
    .list.grid .sub { font-size: 11px; }
    .list.grid .secondary { display: none; }
    .list.grid .item-actions { position: absolute; top: 10px; right: 10px; gap: 4px; opacity: 0; transition: opacity .15s; }
    .list.grid .item:hover .item-actions, .list.grid .item:focus-within .item-actions { opacity: 1; }
    .list.grid .item-actions .icon-btn { width: 28px; height: 28px; border-radius: 50%; background: rgba(15, 16, 24, .62); color: #fff;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    .list.grid .item-actions .icon-btn.accent { background: var(--grad); }
    @media (hover: none) { .list.grid .item-actions, .list.grid .check { opacity: 1; } }
    @media (max-width: 560px) { .list.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

    /* 卡片、保存位置与进度 */
    .hero { border-radius: 14px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .hero-mark { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    .dest { border-radius: 14px; border-color: var(--line); background: var(--soft); }
    .dest .tile { width: 36px; height: 36px; background: var(--bg); }
    .dest.private { background: linear-gradient(135deg, rgba(76, 92, 245, .1), rgba(168, 85, 247, .1)); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .dest.private .tile { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    /* 批次状态：横幅与进度页摘要共用状态图标与语气色（run 渐变、ok 绿、warn 琥珀、err 红） */
    .status-icon { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; flex: none; color: #fff; background: var(--grad); box-shadow: var(--glow); }
    .tone-run .status-icon svg { animation: spin 1s linear infinite; }
    .tone-ok .status-icon { background: linear-gradient(135deg, #22c55e, #12a150); box-shadow: 0 6px 18px -6px rgba(18, 161, 80, .55); }
    .tone-warn .status-icon { background: linear-gradient(135deg, #f5b544, #e08a12); box-shadow: 0 6px 18px -6px rgba(224, 138, 18, .5); }
    .tone-err .status-icon { background: linear-gradient(135deg, #ff6b6f, #e5484d); box-shadow: 0 6px 18px -6px rgba(229, 72, 77, .5); }
    .batch-banner { position: relative; display: flex; align-items: center; padding: 0; border-radius: 14px; background: var(--soft);
      box-shadow: inset 0 0 0 1px var(--line); transition: box-shadow .15s, background .15s; }
    .batch-banner.tone-run { background: linear-gradient(135deg, rgba(76, 92, 245, .1), rgba(168, 85, 247, .1)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
    .batch-banner:hover { box-shadow: inset 0 0 0 1px var(--line-strong); }
    .banner-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 12px; text-align: left; border-radius: 14px; }
    .banner-open .meta { gap: 2px; }
    .banner-open .name { font-weight: 600; }
    .banner-open > svg { color: var(--faint); }
    .banner-open .status-icon { width: 32px; height: 32px; border-radius: 10px; }
    .banner-close { margin-right: 8px; }
    .overview { display: grid; gap: 12px; padding: 14px 16px; border-radius: 16px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .overview-line { display: flex; align-items: center; gap: 12px; }
    .overview-line .meta { gap: 1px; }
    .overview-line strong { font-size: 15px; font-weight: 650; }
    .overview-line .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stats { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .stat { height: 22px; padding: 0 9px; border-radius: 11px; font-size: 12px; font-weight: 600; line-height: 22px; white-space: nowrap; }
    .stat.ok { color: var(--success); background: color-mix(in srgb, var(--success) 13%, transparent); }
    .stat.err { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .stat.run { color: var(--accent); background: var(--accent-soft); }
    .overview .progress { height: 6px; }
    .overview:not(.tone-run) .progress { display: none; }
    /* 进度页的行：清除按钮在悬停时出现，触屏始终显示 */
    @media (hover: hover) {
      .batch-item .row-clear { opacity: 0; transition: opacity .15s; }
      .batch-item:hover .row-clear, .batch-item:focus-within .row-clear { opacity: 1; }
    }
    .batch-item .tile { width: 44px; height: 44px; }
    .batch-item .state.ok { font-weight: 500; }
    .progress { height: 5px; border-radius: 3px; background: var(--soft); }
    .progress > span { background: var(--grad); border-radius: 3px; }
    .progress:not(.done):not(.failed):not(.indeterminate) > span::after { content: ""; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .45), transparent); animation: shimmer 1.4s linear infinite; }
    @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
    .progress.thin { height: 3px; }
    .progress.done > span { background: var(--success); }
    .progress.failed > span { background: var(--danger); }
    .tile-badge { background: var(--success); box-shadow: 0 0 0 2px var(--bg), 0 2px 6px rgba(18, 161, 80, .4); }
    .name-input[type=text] { background: var(--soft); border-radius: 8px; }
    .name-input[type=text]:focus { box-shadow: 0 0 0 3px var(--accent-soft); }
    .segmented { background: var(--soft); border-radius: 10px; }
    .segmented button[aria-checked=true] { color: var(--accent); font-weight: 600; box-shadow: 0 1px 3px rgba(20, 22, 40, .12); }
    .result .tile { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    .switch input:checked + span { background: var(--grad); }
    .empty .tile { background: var(--soft); }
    .toast { border-radius: 12px; padding: 9px 16px; background: rgba(20, 21, 30, .92); color: #fff;
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 12px 30px -8px rgba(0, 0, 0, .45); }

    /* 窄屏把操作放到独立一行，避免触屏按钮挤掉名称或越过面板。 */
    @media (max-width: 560px) {
      .list:not(.grid) > .item.selectable { display: grid; grid-template-columns: 18px 44px minmax(0, 1fr); gap: 6px 10px; }
      .list:not(.grid) > .item.selectable > .item-actions { grid-column: 2 / -1; justify-content: flex-end; flex-wrap: wrap; }
      .batch-item { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 6px 12px; }
      .batch-item > .item-actions { grid-column: 2 / -1; justify-content: flex-end; flex-wrap: wrap; }
      .batch-item .sub { overflow-wrap: anywhere; }
      .overview-line { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px 12px; }
      .overview-line .stats { grid-column: 2; justify-content: flex-start; }
      footer .btn { max-width: 100%; height: auto; min-height: 40px; padding-top: 8px; padding-bottom: 8px;
        white-space: normal; overflow-wrap: anywhere; }
    }
    /* 放在控件基础样式之后，确保 iOS Safari 聚焦输入时不因小字号自动放大页面。 */
    @media (hover: none) and (pointer: coarse) {
      input[type=text], input[type=password], input[type=url], textarea, select, .variant { font-size: 16px; }
      .variant { min-height: 36px; }
      .icon-btn { min-width: 40px; min-height: 40px; }
      .btn { min-height: 40px; }
    }
  `;

  // 线条图标（24×24，描边）。YouTube 等站点启用了 Trusted Types，禁止给 innerHTML 赋字符串，所有节点都用 DOM API 创建。
  const ICONS = {
    settings: ["M20 7h-9", "M14 17H5", ["circle", { cx: 17, cy: 17, r: 3 }], ["circle", { cx: 7, cy: 7, r: 3 }]],
    close: ["M18 6 6 18", "m6 6 12 12"],
    folder: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"],
    folderPlus: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z", "M12 11v5", "M9.5 13.5h5"],
    lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], "M8 11V8a4 4 0 0 1 8 0v3"],
    home: ["M4 11 12 4l8 7", "M6 10v10h12V10"],
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
    upload: ["M12 16V3", "m7 8 5-5 5 5", "M5 21h14"],
    grid: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
    rows: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
    external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "m9 12 2 2 4-4"],
    globe: [["circle", { cx: 12, cy: 12, r: 10 }], "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
    x: ["M4 4l16 16", "M20 4 4 20"],
    youtube: [["rect", { x: 2, y: 5, width: 20, height: 14, rx: 4 }], "m10 9 5 3-5 3z"],
    sparkle: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "m6.3 6.3 2.1 2.1", "m15.6 15.6 2.1 2.1", "m6.3 17.7 2.1-2.1", "m15.6 8.4 2.1-2.1"],
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
    fab = h("button", { type: "button", className: "fab", title: "Tessera 资源抓取（可拖动）", "aria-label": "Tessera 资源抓取" }, logo(26), badge);
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

  const FAB = 42, EDGE = 16;
  /** 位置保存为 { side: "left" | "right", y: 顶部占视口高度的比例 }，跨站点共用。 */
  const fabPosition = () => ({ side: "right", y: null, ...gm.get("fabPosition", {}) });

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
      gm.set("fabPosition", { side: rect.left + FAB / 2 < innerWidth / 2 ? "left" : "right", y: rect.top / innerHeight });
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
    // 手机等窄屏：面板贴底展开成底部抽屉，左右与底部避开安全区域（刘海、Home 指示条）。
    const sheet = innerWidth <= 560;
    panel.classList.toggle("is-sheet", sheet);
    if (sheet) {
      Object.assign(panel.style, { left: "calc(12px + env(safe-area-inset-left))", right: "calc(12px + env(safe-area-inset-right))",
        bottom: "calc(8px + env(safe-area-inset-bottom))", maxHeight: `${Math.min(760, Math.round(innerHeight * 0.86))}px` });
      return;
    }
    panel.style[left ? "left" : "right"] = "12px";
    if (!fabRect) {
      panel.style.bottom = "20px";
      panel.style.maxHeight = `${Math.min(760, innerHeight - 40)}px`;
    } else if (fabRect.top + FAB / 2 > innerHeight / 2) {
      panel.style.bottom = `${innerHeight - fabRect.top + 12}px`;
      panel.style.maxHeight = `${Math.min(760, fabRect.top - 24)}px`;
    } else {
      panel.style.top = `${fabRect.bottom + 12}px`;
      panel.style.maxHeight = `${Math.min(760, innerHeight - fabRect.bottom - 24)}px`;
    }
  }

  /** 无菜单的管理器在非 Tessera 页面需要淡化按钮兜底。 */
  const dormantFab = () => !HAS_MENU && !onTessera();

  function refreshFab() {
    if (!fab) return;
    const count = [...items.values()].filter(item => item.type !== "image").length;
    badge.hidden = count === 0;
    fab.classList.toggle("has-items", count > 0);
    badge.textContent = count > 99 ? "99+" : String(count);
    // 正常显示：已启用且设置里打开了悬浮按钮。没有菜单命令时，未启用或关闭悬浮按钮也保留一个淡化按钮，否则无法再打开设置。
    const dormant = !(settings().fab && active) && dormantFab();
    fab.classList.toggle("is-dormant", dormant);
    fab.style.display = document.fullscreenElement || !(settings().fab && active) && !dormant ? "none" : "";
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
    gm.copy(text);
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
    if (panel.layer) return panel.layer.close();
    panel.back ? panel.back() : close();
  }, true);

  function toggle(context) {
    if (panel && !context) return close();
    open(context);
  }

  /** 面板骨架：标题栏 + 可滚动内容 + 可选的底部操作栏。 */
  function frame(title, body, { back, footer, wide = false, subtitle = "" } = {}) {
    close();
    const header = h("header", {},
      back ? iconButton("back", "返回", back, "back") : h("span", { className: "brand-mark" }, logo(26)),
      h("div", { className: "title-block" }, h("span", { className: "title" }, title), subtitle ? h("span", { className: "subtitle" }, subtitle) : null),
      back ? null : iconButton("settings", "设置", () => openSettings(() => open(currentContext))),
      iconButton("close", "关闭", close));
    panel = h("div", { className: `panel${wide ? " batch-panel" : ""}`, role: "dialog", "aria-label": title }, header, h("div", { className: "body" }, body),
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
    ], { footer: [], subtitle: "资源抓取" });
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
      const canUpload = collect().filter(item => selected.has(item.url)).every(browserEligible);
      footer.hidden = false;
      footer.replaceChildren(
        h("span", { className: "selection" }, `已选 ${selected.size} 项`),
        h("button", { type: "button", className: "text-btn", onclick: () => { selected.clear(); renderList(); } }, "清除"),
        h("span", { className: "spacer" }),
        h("div", { className: "footer-actions" }, h("button", { type: "button", className: "btn", disabled: !canUpload,
          title: canUpload ? "当前浏览器下载后上传到 Tessera" : "流媒体列表请使用服务器下载",
          onclick: () => startBatch([...selected], "local") }, svg("download"), `本地下载 ${selected.size} 项`),
        h("button", { type: "button", className: "btn primary", title: "由 Tessera 服务器下载",
          onclick: () => startBatch([...selected], "server") }, svg("send"), `服务器下载 ${selected.size} 项`)));
      return;
    }
    footer.hidden = onTessera();
    footer.replaceChildren(
      h("span", { className: "site", title: location.hostname }, svg("globe", 14), h("span", {}, currentSite())),
      h("span", { className: "spacer" }),
      h("button", { type: "button", className: "text-btn", title: "把这个页面的图片结构交给 Tessera 文件助手分析",
        onclick: () => openAssistant() }, "发给文件助手"),
      h("button", { type: "button", className: "text-btn", onclick: () => setSiteEnabled(!active) }, active ? "在此网站隐藏" : "在此网站启用"));
  }

  function platformCard(context) {
    const youtube = context.platform === "youtube";
    return h("div", { className: "hero" },
      h("div", { className: "hero-head" },
        h("span", { className: "hero-mark" }, svg(youtube ? "youtube" : "x", 18)),
        h("div", { className: "hero-text" }, h("strong", {}, context.label), h("div", { className: "sub" }, context.url))),
      h("div", { className: "actions" },
        h("button", { type: "button", className: "btn primary block", onclick: () => startBatch([{ url: context.url, platform: context.platform }], "server") }, svg("send"), "服务器下载"),
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
    if (scope) { for (const item of dom) noteMeta(item.url, 0, item.dims); return dom.filter(item => !clearedUrls.has(item.url)); } // 单条帖子只看它自己的媒体
    // DOM 中扫描到的资源也记下来：之后它们离开页面（关闭弹窗、切换标签）仍然留在列表里。
    for (const item of dom) remember(item.url, item.type, { source: item.source, dims: item.dims });
    const merged = new Map();
    for (const item of [...items.values()].reverse()) merged.set(item.url, item);
    if (currentContext && currentContext.platform === "youtube") {
      const cover = `https://i.ytimg.com/vi/${currentContext.id}/maxresdefault.jpg`;
      merged.set(cover, { url: cover, type: "image", source: "封面" });
    }
    return [...merged.values()].filter(item => !clearedUrls.has(item.url));
  }

  function clearResources() {
    for (const item of collect()) clearedUrls.add(item.url);
    items.clear();
    selected.clear();
    rowCache.clear();
    filter = "all";
    refreshFab();
    renderList();
    toast("已清空探测记录");
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
        clear: h("button", { type: "button", className: "text-btn", onclick: clearResources }, "清空"),
        view: h("button", { type: "button", className: "icon-btn view-toggle", onclick: () => { saveSettings({ view: settings().view === "grid" ? "list" : "grid" }); renderList(); } }),
        chips: h("div", { className: "chips" }),
        list: h("div", { className: "list" }),
        empty: emptyState("search", "还没有发现可下载的资源。播放视频或滚动加载图片后再打开。"),
      };
      parts.selectAll = h("span", { className: "select-all", role: "checkbox", tabindex: "0", onclick: () => target.toggleAll(),
        onkeydown: event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); target.toggleAll(); } } }, parts.check);
      target.replaceChildren(
        h("div", { className: "section-head" }, parts.selectAll, h("h2", {}, "页面资源", parts.count), h("span", { className: "spacer" }), parts.clear, parts.view),
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
    // 网格视图：同一批行元素换成缩略图卡片（纯样式切换，不重建节点）。
    const grid = settings().view === "grid";
    if (parts.view.dataset.grid !== String(grid)) {
      parts.view.dataset.grid = String(grid);
      parts.view.replaceChildren(svg(grid ? "rows" : "grid"));
      parts.view.title = grid ? "列表视图" : "网格视图";
      parts.view.setAttribute("aria-label", parts.view.title);
      parts.list.classList.toggle("grid", grid);
    }
    parts.view.hidden = !all.length;
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
    const tile = h("span", { className: "tile" }, item.type === "image"
      ? h("img", { src: item.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
        onload: event => noteMeta(item.url, 0, [event.currentTarget.naturalWidth, event.currentTarget.naturalHeight]) }) : svg(TYPE_ICON[item.type], 18));
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
        h("div", { className: "sub" }, h("span", { className: "sent-tag" }, "已发送"), h("span", { className: "sub-text" }, describe(item)))),
      h("div", { className: "item-actions" },
        // 次要操作在桌面悬停或键盘聚焦时浮现，不占用文件名的宽度；触屏设备始终显示。
        h("span", { className: "secondary" },
          iconButton("link", "复制链接", () => copy(item.url, "已复制链接")),
          iconButton("terminal", "复制 curl 命令", async () => copy(await curlFor(item.url), "已复制 curl 命令")),
          iconButton("external", "在新标签页打开", () => gm.openTab(item.url)),
          h("span", { className: "action-sep", "aria-hidden": "true" })),
        browserEligible(item) ? iconButton("download", "本地下载（当前浏览器下载后上传）", () => startBatch([item.url], "local"))
          : h("button", { type: "button", className: "icon-btn", disabled: true, title: "流媒体列表请使用服务器下载", "aria-label": "本地下载不可用" }, svg("download")),
        iconButton("send", "服务器下载", () => startBatch([item.url], "server"), "accent")));
    node.dataset.url = item.url;
    watchSize(node, item);
    return node;
  }

  // ---------- 资源大小探测 ----------
  // 行进入可见区域后才探测，最多同时 3 个：先 HEAD 读 Content-Length；没有时用 GET Range: bytes=0-0 读 Content-Range，
  // 收到响应头即中止。结果按地址缓存，失败（验证页、403、超时）不再重试；M3U8 只是播放列表，不探测。
  const PROBE_LIMIT = 3;
  const probeQueue = [];
  const probed = new Set();
  let probing = 0, sizeObserver = null;
  function describe(item) {
    let domain = "";
    try { domain = new URL(item.url).hostname.replace(/^www\./, ""); } catch { /* 忽略 */ }
    const meta = resourceMeta.get(item.url) || {};
    return [TYPE_LABEL[item.type], item.type === "stream" ? "播放列表" : meta.size ? formatSize(meta.size) : "",
      meta.dims ? `${meta.dims[0]}×${meta.dims[1]}` : "", domain].filter(Boolean).join(" · ");
  }
  function syncMeta(url) {
    const node = rowCache.get(url), item = node && (items.get(url) || { url, type: node.dataset.type });
    const text = node?.querySelector(".sub-text");
    if (text && item.type) { const value = describe(item); if (text.textContent !== value) text.textContent = value; }
  }
  function watchSize(node, item) {
    node.dataset.type = item.type;
    if (typeof IntersectionObserver !== "function") return wantSize(item);
    sizeObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sizeObserver.unobserve(entry.target);
        wantSize({ url: entry.target.dataset.url, type: entry.target.dataset.type });
      }
    });
    sizeObserver.observe(node);
  }
  function wantSize(item) {
    if (item.type === "stream" || resourceMeta.get(item.url)?.size || probed.has(item.url)) return;
    probed.add(item.url);
    probeQueue.push(item.url);
    pumpProbes();
  }
  function pumpProbes() {
    while (probing < PROBE_LIMIT && probeQueue.length) {
      const url = probeQueue.shift();
      probing += 1;
      requestSize(url).then(size => noteMeta(url, size)).finally(() => { probing -= 1; pumpProbes(); });
    }
  }
  async function requestSize(url) {
    return await probeSize(url, "HEAD") || await probeSize(url, "GET", { Range: "bytes=0-0" });
  }
  function probeSize(url, method, headers) {
    return new Promise(resolve => {
      let request = null, done = false;
      const finish = size => { if (done) return; done = true; clearTimeout(timer); resolve(size || 0); };
      const timer = setTimeout(() => { finish(0); request?.abort(); }, 15000);
      const read = response => {
        if (done || !response?.status || (response.readyState ?? 4) < 2) return false;
        const headersText = response.responseHeaders;
        const total = response.status >= 400 || isChallenge(response.status, headersText) ? 0
          : Number(sourceHeader(headersText, "content-range").match(/\/(\d+)\s*$/)?.[1])
            || (method === "HEAD" || response.status === 200 ? Number(sourceHeader(headersText, "content-length")) : 0);
        finish(total);
        if (method !== "HEAD") request?.abort();
        return true;
      };
      try {
        request = gm.xhr({ method, url, headers, timeout: 15000, onreadystatechange: read,
          onload: response => { if (!read({ ...response, readyState: 4 })) finish(0); },
          onerror: () => finish(0), ontimeout: () => finish(0), onabort: () => finish(0) });
      } catch { finish(0); }
    });
  }

  function syncRow(node, item, sent) {
    const on = selected.has(item.url);
    node.classList.toggle("is-selected", on);
    node.classList.toggle("is-sent", sent);
    node.setAttribute("aria-checked", String(on));
    node.querySelector(".check").classList.toggle("on", on);
    node.querySelector(".sent-tag").hidden = !sent;
  }

  function formatSize(size) {
    if (!size) return "大小未知";
    const units = ["B", "KB", "MB", "GB"];
    let value = size, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  // ----- 保存位置 -----

  const savedDestination = () => ({ path: settings().destination || "", private: Boolean(settings().destinationPrivate) });
  const rememberDestination = dest => saveSettings({ destination: dest.path, destinationPrivate: dest.private });
  const destinationLabel = dest => dest.private ? "私密空间" : dest.path ? dest.path.replace(/\/$/, "") : "根目录";
  const destinationSub = dest => dest.private ? "在 Tessera 页面解锁后确认" : "保存位置";

  /** 保存位置摘要行；点击「更改」在当前面板上打开目录选择层。get/set 由调用方保存状态。 */
  function destinationRow(get, set, allowPrivate = true) {
    const name = h("div", { className: "name" }), sub = h("div", { className: "label" }), tile = h("span", { className: "tile" });
    const row = h("div", { className: "dest" }, tile, h("div", { className: "meta" }, sub, name),
      h("button", { type: "button", className: "btn ghost", onclick: () => openPicker(get(), dest => { set(dest); update(); }, allowPrivate) }, "更改"));
    function update() {
      const dest = get();
      row.className = `dest${dest.private ? " private" : ""}`;
      tile.replaceChildren(svg(dest.private ? "lock" : "folder", 18));
      name.textContent = destinationLabel(dest);
      name.title = name.textContent;
      sub.textContent = destinationSub(dest);
    }
    update();
    return row;
  }

  /** 目录选择层：逐级浏览（GET /api/v1/folders）、新建文件夹（POST /api/v1/folders）或选择私密空间。 */
  function openPicker(initial, onPick, allowPrivate = true) {
    if (!panel) return;
    panel.layer?.close();
    let mode = initial.private && allowPrivate ? "private" : "files";
    let prefix = initial.private ? "" : initial.path;
    let state = { folders: [], next: null, writable: true, loading: true, error: "" };
    let request = 0;
    const body = h("div", { className: "body" });
    const footer = h("footer", {});
    const layer = h("div", { className: "layer", role: "dialog", "aria-label": "选择保存位置" },
      h("header", {}, iconButton("back", "返回", () => closeLayer(), "back"), h("span", { className: "title" }, "选择保存位置")), body, footer);
    const host = panel;
    const closeLayer = () => {
      layer.remove();
      host.classList.remove("has-layer");
      if (panel && panel.layer === controller) panel.layer = null;
    };
    const controller = { close: closeLayer };
    panel.layer = controller;
    host.classList.add("has-layer");
    panel.append(layer);

    async function load(more = false) {
      const id = ++request;
      if (!more) state = { folders: [], next: null, writable: true, loading: true, error: "" };
      else state.loading = true;
      render();
      try {
        const query = `prefix=${encodeURIComponent(prefix)}&limit=100${more && state.next ? `&cursor=${encodeURIComponent(state.next)}` : ""}`;
        const page = await api("GET", `/api/v1/folders?${query}`);
        if (id !== request) return;
        state = { folders: more ? state.folders.concat(page.folders) : page.folders, next: page.next_cursor, writable: page.writable, loading: false, error: "" };
      } catch (error) {
        if (id !== request) return;
        state = { ...state, loading: false, error: error.message };
      }
      render();
    }
    const enter = path => { prefix = path; void load(); };

    function render() {
      const seg = (value, label) => h("button", { type: "button", role: "radio", "aria-checked": String(mode === value),
        disabled: value === "private" && !allowPrivate,
        onclick: () => {
          if (mode === value) return;
          mode = value;
          // 从私密空间打开时还没读取过目录：第一次切到「我的文件」才发请求。
          if (mode === "files" && !request) void load(); else render();
        } }, label);
      const parts = [h("div", { className: "segmented", role: "radiogroup", "aria-label": "目标空间" }, seg("files", "我的文件"), seg("private", "私密空间"))];
      if (mode === "private") {
        parts.push(h("div", { className: "private-note" },
          h("strong", {}, "保存到私密空间"),
          h("span", {}, "访问密钥不能直接写入私密空间，发送时会打开一个 Tessera 标签页：服务器下载转交解析结果，浏览器上传转交下载好的文件。在那里用登录密码或通行密钥解锁、确认后保存。"),
          h("span", {}, "密码只在 Tessera 自己的页面里输入，当前网页和脚本都拿不到。服务器解析结果 20 分钟内有效。")));
        footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: closeLayer }, "取消"),
          h("button", { type: "button", className: "btn primary", onclick: () => { closeLayer(); onPick({ path: "", private: true }); } }, svg("lock"), "选择私密空间"));
        body.replaceChildren(...parts);
        return;
      }
      const segments = prefix.split("/").filter(Boolean);
      const crumbs = [h("button", { type: "button", onclick: () => enter(""), ...(segments.length ? {} : { "aria-current": "page" }) }, "根目录")];
      segments.forEach((segment, index) => {
        const path = segments.slice(0, index + 1).join("/") + "/";
        crumbs.push(svg("chevron", 12), h("button", { type: "button", onclick: () => enter(path), ...(index === segments.length - 1 ? { "aria-current": "page" } : {}) }, segment));
      });
      parts.push(h("nav", { className: "crumbs", "aria-label": "当前位置" }, crumbs));
      if (state.error) parts.push(h("div", { className: "error" }, state.error));
      if (state.folders.length) {
        parts.push(h("div", { className: "list" }, state.folders.map(folder => h("button", { type: "button", className: "folder-row", onclick: () => enter(folder) },
          svg("folder", 18), h("span", { className: "name", title: folder }, folder.slice(prefix.length).replace(/\/$/, "")), svg("chevron", 14)))));
        if (state.next) parts.push(h("button", { type: "button", className: "text-btn", disabled: state.loading, onclick: () => void load(true) }, state.loading ? "加载中…" : "加载更多"));
      } else if (state.loading) parts.push(emptyState("loader", "正在读取文件夹…", true));
      else if (!state.error) parts.push(h("p", { className: "hint" }, "这里没有子文件夹。"));
      // 新建文件夹：建在当前目录下并直接进入。
      const input = h("input", { type: "text", placeholder: "新文件夹名称", maxLength: 255,
        onkeydown: event => { if (event.key === "Enter") { event.preventDefault(); void create(); } } });
      const createButton = h("button", { type: "button", className: "btn", disabled: !state.writable }, svg("folderPlus"), "新建");
      async function create() {
        const name = input.value.trim();
        if (!name) return input.focus();
        if (/[\\/]/.test(name) || name === "." || name === ".." || name.startsWith(".tgdrive")) return toast("文件夹名称不能包含 / 或 \\");
        createButton.disabled = true;
        try { await api("POST", "/api/v1/folders", { path: prefix + name + "/" }); enter(prefix + name + "/"); }
        catch (error) { toast(error.message); createButton.disabled = false; }
      }
      createButton.addEventListener("click", () => void create());
      if (state.writable) parts.push(h("div", { className: "new-folder" }, input, createButton));
      else if (!state.loading) parts.push(h("p", { className: "hint" }, "这个访问密钥不能写入当前目录，请进入有读写权限的文件夹。"));
      footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: closeLayer }, "取消"),
        h("button", { type: "button", className: "btn primary", disabled: !state.writable || state.loading && !state.folders.length,
          onclick: () => { closeLayer(); onPick({ path: prefix, private: false }); } }, `保存到「${destinationLabel({ path: prefix })}」`));
      body.replaceChildren(...parts);
    }
    if (mode === "files") void load(); else render();
  }

  /**
   * 把解析结果转交给 Tessera 页面确认（私密空间）：结果放在地址的 # 片段里，不会发给服务器或进入访问日志；
   * 票据由服务器加密、绑定账号并在 20 分钟后过期，页面读取后立即从地址栏移除。
   */
  function handoff(candidates) {
    const json = JSON.stringify({ private: true, candidates: candidates.map(item => ({ ...item })) });
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    gm.openTab(`${settings().server.replace(/\/+$/, "")}/?view=downloads#import=${encoded}`);
  }

  /**
   * 浏览器上传到私密空间：访问密钥不能写入私密空间，改为把浏览器下载好的文件交给 Tessera 页面（web/src/user/transfer.ts）。
   * 必须在点击事件里同步调用，否则新标签页会被拦截。页面报到后逐个 postMessage 发送 Blob，页面确认收到才算转交成功；
   * 用户在 Tessera 页面里解锁并确认后，文件才通过网页会话上传，密码不会经过当前网页。
   */
  function openTransfer(server) {
    const origin = new URL(server).origin;
    const nonce = [...crypto.getRandomValues(new Uint8Array(18))].map(value => value.toString(16).padStart(2, "0")).join("");
    const tab = page.open(`${origin}/?view=private#receive=${nonce}&from=${encodeURIComponent(location.origin)}`, "_blank");
    if (!tab) throw new Error("浏览器拦截了新标签页，请允许当前网站打开弹出窗口后重试");
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    const pending = new Map();
    let index = 0;
    // 只认 Tessera 的 origin 与本次的随机 nonce；不比较 event.source，脚本与网页运行在不同上下文时窗口对象不一定相等。
    const onMessage = event => {
      const data = event.data;
      if (event.origin !== origin || !data || data.source !== "tessera" || data.nonce !== nonce) return;
      if (data.type === "transfer-ready") markReady();
      const waiter = data.type === "transfer-ack" && pending.get(data.index);
      if (!waiter) return;
      pending.delete(data.index);
      if (data.ok) waiter.resolve(); else waiter.reject(new Error(data.error || "Tessera 页面拒收了文件"));
    };
    window.addEventListener("message", onMessage);
    const within = (promise, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const waitReady = () => within(ready, 300000, "Tessera 页面没有响应：请确认已在新标签页登录 Tessera；部分网站禁止跨站窗口通信，这时请手动保存后上传");
    return {
      async send(blob, name, mime) {
        await waitReady();
        if (tab.closed) throw new Error("Tessera 标签页已关闭，请重试");
        const id = index++;
        const acked = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        tab.postMessage({ source: "tessera-grabber", nonce, type: "file", index: id, name, blob: new Blob([blob], { type: mime }) }, origin);
        await within(acked, 60000, "Tessera 页面没有确认收到文件，请重试");
      },
      end() {
        waitReady().then(() => tab.postMessage({ source: "tessera-grabber", nonce, type: "end" }, origin)).catch(() => {})
          .finally(() => setTimeout(() => window.removeEventListener("message", onMessage), 60000));
      },
    };
  }

  // ----- 发给文件助手（docs/assistant-design.md §9.1） -----

  /**
   * 页面结构快照：与服务端解析 HTML 得到的「规范页」相同（web.py）。图片按元素路径（最近 4 层「标签.首个类名」，数字替换为 *）
   * 聚类，记录 src（currentSrc）、data-* 懒加载地址、srcset 最大项与外层链接；链接只保留像「下一页」或页码的那些。不含正文。
   */
  const ASSISTANT_MAX_PAGES = 50, ASSISTANT_MAX_IMAGES = 5000, ASSISTANT_MAX_BYTES = 2 * 1024 * 1024, ASSISTANT_TTL = 86400000;
  const NEXT_TEXT = /^\s*(下一页|下页|后页|下一张|next(\s*page)?|older|more|›|»|>|→)\s*[›»>→]?\s*$/i;
  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];

  function segmentOf(node) {
    const tag = node.tagName.toLowerCase();
    const first = (node.getAttribute("class") || "").split(/\s+/).find(Boolean) || "";
    const cls = first.replace(/[^A-Za-z0-9_-]/g, "").replace(/\d+/g, "*").slice(0, 30);
    return cls ? `${tag}.${cls}` : tag;
  }
  function pathOf(node) {
    const chain = [];
    for (let current = node; current && current.nodeType === 1 && chain.length < 4; current = current.parentElement) {
      if (current.tagName.toLowerCase() === "html") break;
      chain.unshift(segmentOf(current));
    }
    return chain.join(">");
  }
  function absolute(value, base) {
    if (!value) return null;
    try {
      const url = new URL(value.trim(), base);
      return /^https?:$/.test(url.protocol) && url.href.length <= 2048 ? url.href.split("#")[0] : null;
    } catch { return null; }
  }
  function largestSrcset(value) {
    let best = null, size = -1;
    for (const part of (value || "").split(",")) {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) continue;
      const match = /^([\d.]+)([wx])$/.exec(descriptor || "");
      const current = match ? parseFloat(match[1]) * (match[2] === "w" ? 1 : 1000) : 1;
      if (current > size) { best = url; size = current; }
    }
    return best;
  }
  function pageSnapshot(doc = document, url = location.href) {
    const images = [];
    for (const img of [...(doc.images || [])].slice(0, 2000)) {
      if (host && host.contains && host.contains(img)) continue;
      const width = img.naturalWidth || Number(img.getAttribute("width")) || null;
      const height = img.naturalHeight || Number(img.getAttribute("height")) || null;
      if (width && height && width < 32 && height < 32) continue;
      const urls = {};
      const src = absolute(img.currentSrc || img.getAttribute("src"), url);
      if (src) urls.src = src;
      for (const name of LAZY_ATTRS) { const value = absolute(img.getAttribute(name), url); if (value) urls[name] = value; }
      const srcset = absolute(largestSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")), url);
      if (srcset) urls.srcset = srcset;
      const anchor = img.closest && img.closest("a[href]");
      const href = anchor && absolute(anchor.getAttribute("href"), url);
      if (href) urls.href = href;
      if (Object.keys(urls).length) images.push({ path: pathOf(img), urls, w: width, h: height });
    }
    const links = [];
    for (const anchor of [...doc.querySelectorAll("a[href], link[rel~=next]")]) {
      const text = (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const rel = (anchor.getAttribute("rel") || "").toLowerCase();
      if (!rel.split(/\s+/).includes("next") && !NEXT_TEXT.test(text) && !/^\d{1,4}$/.test(text)) continue;
      const href = absolute(anchor.getAttribute("href"), url);
      if (href) links.push({ path: pathOf(anchor), href, text, rel });
      if (links.length >= 60) break;
    }
    return { url: absolute(url, url) || url, title: (doc.title || "").replace(/\s+/g, " ").trim().slice(0, 200), images, links };
  }

  /** 多页暂存（GM_setValue "assistant-pages"）：同一来源最多 50 页、5,000 个图片候选、2 MB，24 小时过期。 */
  function assistantPages(origin = location.origin) {
    const stored = gm.get("assistant-pages", null);
    if (!stored || stored.origin !== origin || Date.now() - stored.savedAt > ASSISTANT_TTL) return [];
    return Array.isArray(stored.pages) ? stored.pages : [];
  }
  function addAssistantPage(snapshot, origin = location.origin) {
    const pages = assistantPages(origin).filter(page => page.url !== snapshot.url);
    const next = [...pages, snapshot];
    const images = next.reduce((sum, page) => sum + page.images.length, 0);
    if (next.length > ASSISTANT_MAX_PAGES) throw new Error(`最多暂存 ${ASSISTANT_MAX_PAGES} 页，请先发送`);
    if (images > ASSISTANT_MAX_IMAGES) throw new Error(`图片候选超过 ${ASSISTANT_MAX_IMAGES} 个，请先发送已暂存的页面`);
    if (new TextEncoder().encode(JSON.stringify(next)).length > ASSISTANT_MAX_BYTES) throw new Error("暂存的快照超过 2 MB，请先发送");
    gm.set("assistant-pages", { origin, savedAt: Date.now(), pages: next });
    return next;
  }
  const clearAssistantPages = () => gm.set("assistant-pages", null);

  /**
   * 打开 Tessera 页面并转交快照：必须在点击事件里同步 window.open；页面报到后 postMessage 发送，收到确认后清空暂存。
   * 协议与 web/src/user/page-import.ts 一致，只认 Tessera 的 origin 与本次的随机 nonce。
   */
  function sendAssistantPages(server, pages) {
    const origin = new URL(server).origin;
    const nonce = [...crypto.getRandomValues(new Uint8Array(18))].map(value => value.toString(16).padStart(2, "0")).join("");
    const tab = page.open(`${origin}/?view=files#assistant-page=${nonce}&from=${encodeURIComponent(location.origin)}`, "_blank");
    if (!tab) throw new Error("浏览器拦截了新标签页，请允许当前网站打开弹出窗口后重试");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(new Error("Tessera 页面没有响应：请确认已在新标签页登录 Tessera；部分网站禁止跨站窗口通信")); }, 300000);
      const finish = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
      const onMessage = event => {
        const data = event.data;
        if (event.origin !== origin || !data || data.source !== "tessera" || data.nonce !== nonce) return;
        if (data.type === "page-ready") tab.postMessage({ source: "tessera-grabber", nonce, type: "page-snapshot", pages }, origin);
        if (data.type === "page-ack") { finish(); if (data.ok) resolve(); else reject(new Error(data.error || "Tessera 页面拒收了快照")); }
      };
      window.addEventListener("message", onMessage);
    });
  }

  let scrolling = null;
  /** 先滚动到底部：触发懒加载，最多 30 秒或 200 屏，连续 3 次高度不变即停止；可随时停止。 */
  function autoScroll(onDone) {
    const started = Date.now();
    let screens = 0, stable = 0, height = 0;
    const step = () => {
      const current = document.documentElement.scrollHeight;
      stable = current === height ? stable + 1 : 0;
      height = current;
      if (stable >= 3 || screens >= 200 || Date.now() - started > 30000 || !scrolling) { stopScroll(); onDone(); return; }
      window.scrollBy(0, innerHeight * .9);
      screens += 1;
      scrolling = setTimeout(step, 450);
    };
    scrolling = setTimeout(step, 0);
  }
  const stopScroll = () => { clearTimeout(scrolling); scrolling = null; };

  function openAssistant() {
    mount();
    const server = settings().server;
    const status = h("div", { className: "status", hidden: true });
    const summary = h("div", { className: "hint" });
    const scrollButton = h("button", { type: "button", className: "btn" });
    const addButton = h("button", { type: "button", className: "btn" }, svg("folderPlus"), "加入本页并继续");
    const sendButton = h("button", { type: "button", className: "btn primary" });
    const show = (text, error = false) => { status.hidden = false; status.className = `status${error ? " error" : ""}`; status.textContent = text; };
    const refresh = () => {
      const pages = assistantPages();
      const here = pages.some(page => page.url === location.href);
      const total = pages.length + (here ? 0 : 1);
      summary.textContent = pages.length
        ? `已暂存 ${pages.length} 页（${pages.reduce((sum, page) => sum + page.images.length, 0)} 个图片候选）。翻到下一页后点「加入本页并继续」，最后一起发送。`
        : "把当前页面的图片结构（不含正文）交给 Tessera 文件助手分析，再由你在 Tessera 里确认保存。需要多页时，逐页加入后一起发送。";
      sendButton.replaceChildren(svg("send"), total > 1 ? `发送 ${total} 页给助手` : "发送本页给助手");
      scrollButton.replaceChildren(svg(scrolling ? "close" : "download"), scrolling ? "停止滚动" : "先滚动到底部");
    };
    scrollButton.onclick = () => {
      if (scrolling) { stopScroll(); refresh(); return; }
      autoScroll(() => { refresh(); show("已滚动到底部，懒加载的图片已出现在快照里"); });
      refresh();
    };
    addButton.onclick = () => {
      try {
        const pages = addAssistantPage(pageSnapshot());
        show(`已加入第 ${pages.length} 页。请自己翻到下一页，再打开面板继续加入。`);
      } catch (error) { show(error.message, true); }
      refresh();
    };
    sendButton.onclick = () => {
      if (!server) { show("请先在设置中填写 Tessera 服务器地址", true); return; }
      let pages;
      try {
        const current = pageSnapshot();
        const stored = assistantPages().filter(page => page.url !== current.url);
        pages = [...stored, current];
        const images = pages.reduce((sum, page) => sum + page.images.length, 0);
        if (pages.length > ASSISTANT_MAX_PAGES || images > ASSISTANT_MAX_IMAGES) throw new Error("页数或图片候选超过上限，请减少暂存的页面");
        if (!images) throw new Error("这个页面没有找到图片，可以先滚动到底部再试");
        const pending = sendAssistantPages(server, pages);
        show("已打开 Tessera，正在转交快照…");
        pending.then(() => { clearAssistantPages(); refresh(); show("已转交。请在 Tessera 的文件助手里确认后发送。"); })
          .catch(error => show(error.message, true));
      } catch (error) { show(error.message, true); }
    };
    refresh();
    frame("发给文件助手", [
      h("div", { className: "section" }, summary, status),
      h("div", { className: "section actions-row" }, scrollButton, addButton),
    ], { back: () => { stopScroll(); open(currentContext); }, subtitle: location.hostname,
      footer: [h("button", { type: "button", className: "text-btn", onclick: () => { clearAssistantPages(); refresh(); show("已清空暂存的页面"); } }, "清空暂存"),
        h("span", { className: "spacer" }), sendButton] });
  }

  // ----- 保存到 Tessera：本地下载与服务器下载共用的确认与进度页 -----

  /**
   * 批次在页面内存中保存：关闭面板后继续传输、轮询进度，重新打开时主面板顶部显示入口。两种方式共用同一个确认页
   * （保存位置含私密空间、逐项保存文件名），只是读取文件的一方不同：
   * - 本地下载（local）：当前浏览器读取直链 → PUT 临时名 → move 提交；私密空间把文件交给 Tessera 页面。
   *   waiting → downloading → uploading → saving → completed（私密：transferring → handoff）。
   * - 服务器下载（server）：打开确认页时先解析，每个分组一行，同组的不同清晰度用下拉选择；开始后逐行创建离线任务并轮询。
   *   私密空间把解析结果（含修改后的文件名）转交 Tessera 页面确认。parsing → waiting → creating → submitted（私密：handoff）。
   */
  let batch = null;
  const TERMINAL = ["completed", "failed", "stopped"];
  const PHASE = { resolving: "解析媒体…", downloading: "下载中", merging: "合并中…", saving: "保存中…" };
  const MODE_LABEL = { local: "本地下载", server: "服务器下载" };

  /** 解析结果按文件名判断类型，用于行图标；判断不出时沿用来源资源的类型。 */
  function candidateType(candidate, fallback) {
    const name = String(candidate.name || "").toLowerCase();
    if (/\.(?:jpe?g|png|gif|webp|avif|heic|bmp|svg)$/.test(name)) return "image";
    if (/\.(?:mp4|m4v|webm|mov|mkv|ts)$/.test(name)) return "video";
    if (/\.(?:mp3|m4a|aac|flac|ogg|opus|wav)$/.test(name)) return "audio";
    return fallback === "stream" ? "video" : fallback;
  }

  /** sources：资源地址，或 { url, platform }（X 帖子、YouTube 视频只能服务器下载）。 */
  function startBatch(sources, mode) {
    if (!settings().server || !settings().key) {
      toast("请先填写 Tessera 地址和访问密钥");
      return openSettings(() => open(currentContext));
    }
    if (batch && batch.started && !batchDone()) return toast("上一批还在进行，请等待完成后再开始新的一批");
    const wanted = sources.map(source => typeof source === "string" ? { url: source, platform: null } : source);
    // 按资源列表的显示顺序处理，而不是勾选的先后顺序。
    const listed = collect();
    const known = new Map(listed.map(item => [item.url, item]));
    const byUrl = new Map(wanted.map(source => [source.url, source]));
    const ordered = [...listed.filter(item => byUrl.has(item.url)).map(item => byUrl.get(item.url)), ...wanted.filter(source => !known.has(source.url))];
    batch = { started: false, mode, destination: savedDestination(),
      entries: ordered.slice(0, BATCH_LIMIT).map(({ url, platform }) => ({ url, platform: platform || null,
        type: known.get(url)?.type || (platform ? "video" : "file"), name: mode === "local" ? defaultSaveName(url) : "",
        state: mode === "server" ? "parsing" : "waiting", error: "", tasks: [] })) };
    openBatch();
    if (mode === "server") void parseEntries(batch, batch.entries.slice());
  }

  /** 服务器解析：两路并行（服务端同时最多解析 2 个）。 */
  async function parseEntries(current, entries) {
    const queue = entries.slice();
    const worker = async () => { while (queue.length && batch === current) await parseEntry(queue.shift(), current); };
    await Promise.all([worker(), worker()]);
  }

  async function parseEntry(entry, current) {
    entry.state = "parsing"; entry.error = "";
    updateBatch();
    try {
      // 平台链接单独传 Cookie；文件直链把 Cookie 写进 curl 命令，与网页「下载任务」的规则一致。
      const payload = entry.platform
        ? { input: entry.url, cookies: settings().cookies ? await cookieHeader(entry.url) : "" }
        : { input: await curlFor(entry.url) };
      const parsed = await api("POST", "/api/v1/downloads/parse", payload);
      const candidates = parsed.candidates || [];
      if (!candidates.length) throw new Error("没有可下载的文件");
      if (batch !== current) return;
      // 每个分组（X 帖子的每张图、每个视频）一行；同组的不同清晰度默认第一个，可在行内切换。
      const groups = new Map();
      for (const candidate of candidates) {
        const key = candidate.group || candidate.ticket;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(candidate);
      }
      const index = current.entries.indexOf(entry);
      if (index < 0) return;
      const room = BATCH_LIMIT - current.entries.length + 1;
      const rows = [...groups.values()].slice(0, Math.max(1, room)).map(variants => ({ url: entry.url, platform: entry.platform,
        type: candidateType(variants[0], entry.type), variants, candidate: variants[0], name: variants[0].name, nameEdited: false,
        state: current.started ? "error" : "waiting", error: "", tasks: [] }));
      current.entries.splice(index, 1, ...rows);
    } catch (error) {
      entry.state = "parse-error";
      entry.error = error.message;
    }
    updateBatch();
  }

  /** 可以编辑并参与保存的条目：本地下载全部条目，服务器下载只有解析成功的条目。 */
  const nameable = (current, entry) => current.mode === "local" || Boolean(entry.candidate);

  function batchNameProblems(current) {
    const problems = new Map(), seen = new Map();
    for (const entry of current.entries) {
      if (!nameable(current, entry) || current.started && !entryFailed(entry)) continue;
      const problem = saveNameProblem(entry.name);
      if (problem) { problems.set(entry, problem); continue; }
      const name = entry.name.trim().normalize("NFC");
      if (seen.has(name)) {
        problems.set(entry, "本批次保存文件名重复，请修改");
        problems.set(seen.get(name), "本批次保存文件名重复，请修改");
      } else seen.set(name, entry);
    }
    return problems;
  }

  function syncBatchNames() {
    if (!batch) return;
    const problems = batchNameProblems(batch);
    for (const entry of batch.entries) {
      if (!entry.row) continue;
      const problem = problems.get(entry) || "";
      entry.row.nameError.textContent = problem;
      entry.row.nameError.hidden = !problem || entry.row.nameInput.hidden;
      entry.row.nameInput.setAttribute("aria-invalid", String(Boolean(problem)));
      const retry = entry.row.action.querySelector("[data-retry]");
      if (retry) retry.disabled = batch.running || Boolean(problem);
    }
    if (batch.submit) {
      const ready = batch.entries.filter(entry => entry.state === "waiting").length;
      const parsing = batch.entries.some(entry => entry.state === "parsing");
      batch.submit.disabled = problems.size > 0 || parsing || !ready;
      const label = batch.submit.querySelector("span");
      label.textContent = parsing ? "正在解析…" : batch.destination.private && batch.mode === "server" ? `到 Tessera 确认 ${ready} 项`
        : `${batch.mode === "local" ? "开始上传" : "开始下载"} ${ready} 项`;
    }
    const retryAll = panel?.querySelector("[data-retry-failed]");
    if (retryAll) retryAll.disabled = batch.running || problems.size > 0;
  }

  const entryActive = entry => ["parsing", "creating", "downloading", "uploading", "saving", "transferring"].includes(entry.state)
    || entry.state === "waiting" && batch.started
    || entry.state === "submitted" && entry.tasks.some(task => !TERMINAL.includes(task.status));
  const entryOk = entry => entry.state === "completed" || entry.state === "handoff" || entry.state === "submitted" && entry.tasks.length > 0 && entry.tasks.every(task => task.status === "completed");
  const entryFailed = entry => ["error", "stopped", "parse-error"].includes(entry.state) || entry.state === "submitted" && entry.tasks.some(task => task.status === "failed" || task.status === "stopped");
  const batchDone = () => !batch || batch.started && !batch.entries.some(entryActive);

  async function runBatch() {
    if (batch.running) return;
    const current = batch;
    if (current.mode === "local") for (const entry of current.entries) entry.name ??= defaultSaveName(entry.url);
    const problem = batchNameProblems(current).values().next().value;
    if (problem) return toast(problem);
    const queue = current.entries.filter(entry => entry.state === "waiting");
    if (!queue.length) return toast("没有可保存的文件");
    // 开始后未解析成功的行按失败处理，可单独重试。
    if (!current.started) for (const entry of current.entries) if (entry.state === "parse-error") entry.state = "error";
    current.started = true;
    current.running = true;
    current.controller = new AbortController();
    current.config ||= settings();
    selected.clear();
    rememberDestination(current.destination);
    const privateSpace = current.destination.private;
    // 私密空间 + 服务器下载：解析结果连同修改后的文件名一次性转交 Tessera 页面确认。
    if (current.mode === "server" && privateSpace) {
      handoff(queue.map(entry => ({ ...entry.candidate, name: entry.name.trim().normalize("NFC") })));
      for (const entry of queue) { entry.state = "handoff"; entry.delivered = true; }
      current.running = false;
      toast(`已在 Tessera 中打开 ${queue.length} 项，请在那里解锁并确认`);
      return updateBatch();
    }
    if (current.mode === "local" && privateSpace) {
      // 新标签页必须在点击事件里同步打开，放在任何 await 之前。
      try { current.transfer = openTransfer(current.config.server); }
      catch (error) {
        for (const entry of queue) { entry.state = "error"; entry.error = error.message; }
        current.running = false;
        return updateBatch();
      }
    }
    updateBatch();
    if (current.mode === "local" && !privateSpace) {
      try {
        const folder = await api("GET", `/api/v1/folders?prefix=${encodeURIComponent(current.destination.path)}&limit=1`, undefined,
          { config: current.config, signal: current.controller.signal });
        if (!folder?.writable) throw new Error("访问密钥不能写入所选目录，请更改保存位置或密钥授权");
      } catch (error) {
        for (const entry of queue) { entry.state = error.name === "AbortError" ? "stopped" : "error"; entry.error = error.message; }
        current.running = false;
        return updateBatch();
      }
    }
    const worker = async () => {
      while (queue.length && batch === current && !current.controller.signal.aborted) {
        const entry = queue.shift();
        await (current.mode === "local" ? uploadEntry(entry, current) : createEntry(entry, current));
      }
    };
    // 本地下载一次只处理一个文件（内存与带宽）；服务器下载两路创建任务。
    await Promise.all(current.mode === "local" ? [worker()] : [worker(), worker()]);
    current.running = false;
    if (current.transfer) { current.transfer.end(); current.transfer = null; }
    if (batch === current) updateBatch();
  }

  async function uploadEntry(entry, current) {
    entry.state = "downloading"; entry.error = ""; entry.received = 0; entry.total = null; entry.uploaded = 0;
    updateBatch();
    const signal = current.controller.signal;
    let staged = false;
    try {
      const { blob, mime } = await browserDownload(entry.url, entry.type, { signal, cookies: current.config.cookies,
        onprogress: (received, total) => { entry.received = received; entry.total = total; updateBatch(); } });
      if (signal.aborted) throw stoppedError();
      entry.size = blob.size;
      if (current.transfer) {
        entry.state = "transferring";
        updateBatch();
        await current.transfer.send(blob, uploadSaveName(entry, mime), mime);
        entry.state = "handoff";
        entry.delivered = true;
        markSent([entry.url]);
        return updateBatch();
      }
      entry.path ||= current.destination.path + uploadSaveName(entry, mime);
      entry.stagePath ||= current.destination.path + browserTemporaryName();
      entry.state = "uploading";
      updateBatch();
      staged = true;
      const result = await api("PUT", `/api/v1/files?path=${encodeURIComponent(entry.stagePath)}`, blob,
        { config: current.config, signal, contentType: mime, binary: true,
          onprogress: event => { entry.uploaded = event.loaded || 0; updateBatch(); } });
      if (result?.key !== entry.stagePath || result.size !== blob.size) throw new Error("Tessera 未确认文件保存成功，请检查保存目录后重试");
      entry.state = "saving";
      updateBatch();
      const moved = await api("POST", "/api/v1/move", { from: entry.stagePath, to: entry.path, conflict: "skip" }, { config: current.config, signal });
      if (moved?.skipped) throw new Error("保存目录已有同名文件，已保留原文件；请修改保存文件名后重试");
      if (moved?.moved !== 1) throw new Error("Tessera 未确认保存文件名，请检查保存目录后重试");
      entry.state = "completed";
      markSent([entry.url]);
    } catch (error) {
      let cleanupFailed = false;
      if (staged) {
        try {
          const removed = await api("POST", "/api/v1/delete", { paths: [entry.stagePath] }, { config: current.config, timeout: 10000 });
          if (!removed?.results?.some(item => item.path === entry.stagePath)) cleanupFailed = true;
        } catch { cleanupFailed = true; }
      }
      entry.state = error.name === "AbortError" ? "stopped" : "error";
      entry.challenge = Boolean(error.challenge);
      entry.error = error.message + (cleanupFailed ? `；未完成的上传清理失败，请检查 ${entry.stagePath}` : "");
      markSent([entry.url], false);
    }
    updateBatch();
  }

  function stopBatch() {
    if (!batch || batch.mode !== "local") return;
    batch.controller.abort();
    for (const entry of batch.entries) if (entry.state === "waiting") { entry.state = "stopped"; entry.error = "已停止"; }
    updateBatch();
  }

  async function createEntry(entry, current) {
    entry.state = "creating"; entry.error = ""; entry.tasks = [];
    updateBatch();
    try {
      const result = await api("POST", "/api/v1/downloads", {
        items: [{ ticket: entry.candidate.ticket, name: entry.name.trim().normalize("NFC") }],
        destination: current.destination.path,
      }, { config: current.config });
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

  /** 重试：解析失败的行重新解析（成功后按新行继续），其余行重新传输或重新创建任务。 */
  async function retryEntries(entries) {
    if (batch.running) return toast("请等待当前批次完成或停止后再重试");
    const problem = batchNameProblems(batch).values().next().value;
    if (problem) return toast(problem);
    const current = batch;
    const unparsed = entries.filter(entry => !nameable(current, entry));
    for (const entry of entries) {
      if (!nameable(current, entry)) continue;
      entry.state = "waiting"; entry.error = ""; entry.tasks = []; entry.challenge = false; entry.delivered = false;
    }
    if (unparsed.length) {
      // 先按未开始的状态解析，新行为 waiting，再一起开始。
      const started = current.started;
      current.started = false;
      current.running = true;
      await parseEntries(current, unparsed);
      current.running = false;
      current.started = started;
      if (batch !== current) return;
    }
    void runBatch();
  }

  /** 进度页清除已结束的行（不影响已保存的文件和服务器任务）；全部清除后回到资源列表。 */
  function clearEntries(entries) {
    const gone = new Set(entries.filter(entry => !entryActive(entry)));
    batch.entries = batch.entries.filter(entry => !gone.has(entry));
    if (!batch.entries.length) return clearBatch();
    renderBatch();
  }

  /** 确认页移除一行；全部移除后回到资源列表。 */
  function removeEntry(entry) {
    batch.entries = batch.entries.filter(item => item !== entry);
    if (!batch.entries.length) { batch = null; return open(currentContext); }
    renderBatch();
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
        const { tasks } = await api("GET", `/api/v1/downloads?ids=${ids.join(",")}`, undefined, { config: batch.config || settings() });
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

  /** 批次整体状态：图标、语气与标题，横幅和进度页共用。 */
  function batchHeadline() {
    const { total, ok, failed, finished } = batchSummary();
    const label = MODE_LABEL[batch.mode];
    const running = total - ok - failed;
    const tone = !finished ? "run" : failed ? ok ? "warn" : "err" : "ok";
    return {
      tone, total, ok, failed, running, finished,
      icon: tone === "run" ? "loader" : tone === "ok" ? "check" : "alert",
      title: !finished ? `正在${label}` : tone === "ok" ? `${label}完成` : tone === "warn" ? `${label}部分失败` : `${label}失败`,
      width: `${total ? (ok + failed) / total * 100 : 0}%`,
      bar: `progress${finished ? !failed ? " done" : !ok ? " failed" : "" : ""}`,
    };
  }

  /** 清除批次记录（不影响已保存的文件和服务器任务）。 */
  function clearBatch() {
    if (batch && batch.started && !batchDone()) return toast("还有文件在传输，请等待完成或停止后再清除");
    batch = null;
    if (panel && panel.dataset.view === "batch") open(currentContext);
    else renderBanner();
  }

  /** 主面板顶部的批次入口：只创建一次，之后原地更新文字和进度，避免轮询时替换节点吞掉点击；结束后可关闭。 */
  function renderBanner() {
    const target = panel && panel.querySelector(".banner-host");
    if (!target) return;
    target.hidden = !batch || !batch.started;
    if (target.hidden) return target.replaceChildren();
    let banner = target.querySelector(".batch-banner");
    if (!banner) {
      banner = h("div", { className: "batch-banner" },
        h("button", { type: "button", className: "banner-open", onclick: openBatch },
          h("span", { className: "status-icon" }),
          h("div", { className: "meta" }, h("div", { className: "name" }), h("div", { className: "sub" }), h("div", { className: "progress thin" }, h("span"))),
          svg("chevron")),
        iconButton("close", "清除记录", clearBatch, "banner-close"));
      target.replaceChildren(banner);
    }
    const head = batchHeadline();
    banner.className = `batch-banner tone-${head.tone}`;
    const icon = banner.querySelector(".status-icon");
    if (icon.dataset.icon !== head.icon) { icon.dataset.icon = head.icon; icon.replaceChildren(svg(head.icon, 16, head.icon === "check" ? 2.6 : 2)); }
    banner.querySelector(".name").textContent = head.title;
    banner.querySelector(".sub").textContent = head.finished
      ? `${[head.ok ? `成功 ${head.ok}` : "", head.failed ? `失败 ${head.failed}` : ""].filter(Boolean).join(" · ")} · 点击查看详情`
      : `已完成 ${head.ok} / ${head.total}${head.failed ? ` · 失败 ${head.failed}` : ""}`;
    banner.querySelector(".progress").className = `${head.bar} thin`;
    banner.querySelector(".progress").hidden = head.finished;
    banner.querySelector(".progress > span").style.width = head.width;
    banner.querySelector(".banner-close").hidden = !head.finished;
  }

  function openBatch() {
    if (!batch) return open(currentContext);
    frame(MODE_LABEL[batch.mode], h("div", { className: "batch-host" }), { back: () => open(currentContext), footer: [], wide: true });
    panel.dataset.view = "batch";
    renderBatch();
  }

  /** 一个条目的状态文字、语气与进度（0–1，null 为不确定进度，undefined 为不显示）。 */
  function entryStatus(entry) {
    if (entry.state === "waiting") return { text: batch.started ? "等待中" : "" };
    if (entry.state === "parsing") return { text: "服务器解析中…", tone: "run", progress: null };
    if (entry.state === "parse-error") return { text: entry.error || "解析失败", tone: "err" };
    if (entry.state === "creating") return { text: "提交任务…", tone: "run", progress: null };
    if (entry.state === "error") return { text: entry.error || "保存失败", tone: "err" };
    if (entry.state === "stopped") return { text: entry.error || "已停止", tone: "err" };
    if (entry.state === "saving") return { text: "正在保存文件…", tone: "run", progress: null };
    if (entry.state === "transferring") return { text: "正在交给 Tessera 页面…", tone: "run", progress: null };
    if (entry.state === "completed") return { text: `已上传 · ${formatSize(entry.size)} · ${entry.path}`, tone: "ok", progress: 1 };
    if (entry.state === "downloading" || entry.state === "uploading") {
      const upload = entry.state === "uploading";
      const received = upload ? entry.uploaded : entry.received;
      const total = upload ? entry.size : entry.total;
      const progress = total ? Math.min(1, received / total) : null;
      return { text: `${upload ? "上传中" : "浏览器下载中"} · ${progress === null ? formatSize(received) : `${Math.floor(progress * 100)}%`}${upload && progress === 1 ? " · 等待保存确认" : ""}`, tone: "run", progress };
    }
    if (entry.state === "handoff") return { text: `已转交 Tessera 确认${entry.size ? ` · ${formatSize(entry.size)}` : ""}`, tone: "ok", progress: 1 };
    const task = entry.tasks.find(item => !TERMINAL.includes(item.status)) || entry.tasks.find(item => item.status !== "completed") || entry.tasks[0];
    if (!task) return { text: "已提交" };
    if (task.status === "completed") return { text: `已完成 · ${formatSize(task.stored_bytes || task.size)} · ${task.key}`, tone: "ok", progress: 1 };
    if (task.status === "failed") return { text: task.error || "下载失败", tone: "err" };
    if (task.status === "stopped") return { text: task.error ? `已停止：${task.error}` : "已停止", tone: "err" };
    if (task.status === "queued") return { text: "服务器排队中", progress: 0 };
    if (task.status === "interrupted") return { text: task.error || "等待重试", tone: "run", progress: null };
    const fraction = task.segments_total ? task.segments_done / task.segments_total
      : task.size ? Math.min(1, (task.received || 0) / task.size) : null;
    const parts = [`服务器${PHASE[task.phase] || "下载中"}`];
    if (task.phase === "downloading" || !task.phase) {
      if (fraction != null) parts.push(`${Math.floor(fraction * 100)}%`);
      else if (task.received) parts.push(formatSize(task.received));
      if (task.speed) parts.push(`${formatSize(task.speed)}/s`);
    }
    return { text: parts.join(" · "), tone: "run", progress: task.phase === "downloading" || !task.phase ? fraction : null };
  }

  /**
   * 批次条目的行：每个条目只创建一次，轮询时原地更新状态，保证按钮可以点到。
   * 紧凑布局：缩略图 | 保存文件名（可直接修改）+ 一行说明或状态 + 细进度条 | 行尾按钮。
   */
  let nameFieldSequence = 0;
  function batchRow(entry) {
    if (!entry.row) {
      const thumbnail = entry.type === "image" && !entry.platform;
      const tile = h("span", { className: "tile" }, thumbnail
        ? h("img", { src: entry.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: event => event.currentTarget.replaceWith(svg("image", 18)) })
        : svg(TYPE_ICON[entry.type] || "file", 18));
      const badge = h("span", { className: "tile-badge", hidden: true }, svg("check", 10, 3.4));
      const state = h("div", { className: "state" });
      const bar = h("div", { className: "progress thin" }, h("span"));
      const action = h("span", { className: "item-actions" });
      const errorId = `tessera-name-error-${++nameFieldSequence}`;
      const nameInput = h("input", { type: "text", className: "name-input", value: entry.name || "",
        "aria-label": `保存文件名：${fileName(entry.url)}`, "aria-describedby": errorId, autocomplete: "off", spellcheck: "false", title: "保存文件名，可直接修改" });
      const nameError = h("div", { id: errorId, className: "error", hidden: true });
      const nameText = h("div", { className: "name", title: entry.url });
      nameInput.addEventListener("input", () => { entry.name = nameInput.value; entry.nameEdited = true; entry.path = null; syncBatchNames(); });
      let domain = "";
      try { domain = new URL(entry.url).hostname.replace(/^www\./, ""); } catch { /* 忽略无效地址 */ }
      const size = h("span", { className: "size" });
      const sub = h("div", { className: "sub", title: entry.url }, h("span", {}, `${TYPE_LABEL[entry.type] || "文件"}${domain ? ` · ${domain}` : ""}`));
      // 服务器解析出同一分组的多个清晰度：下拉切换，未改过文件名时跟随候选的默认名。
      if (entry.variants?.length > 1) {
        const select = h("select", { className: "variant", "aria-label": "清晰度",
          onchange: () => {
            entry.candidate = entry.variants[select.selectedIndex];
            if (!entry.nameEdited) { entry.name = entry.candidate.name; nameInput.value = entry.name; }
            syncBatchNames();
            renderBatch();
          } }, entry.variants.map(variant => h("option", {}, variant.variant || variant.name)));
        sub.append(select);
      } else if (entry.candidate?.variant) sub.append(h("span", {}, entry.candidate.variant));
      if (entry.candidate || batch.mode === "local") sub.append(size);
      const warnings = h("div", { className: "warn" }, (entry.candidate?.warnings || []).join("；"));
      warnings.hidden = !entry.candidate?.warnings?.length;
      entry.row = { node: h("div", { className: "item batch-item" }, h("span", { className: "tile-wrap" }, tile, badge),
        h("div", { className: "meta" }, nameText, nameInput, nameError, sub, warnings, state, bar), action),
        badge, state, bar, action, nameInput, nameText, nameError, sub, size, actionKey: "" };
    }
    const { badge, state, bar, action, nameInput, nameText, sub, size } = entry.row;
    const failed = entryFailed(entry) && !entryActive(entry);
    const editable = nameable(batch, entry) && (!batch.started || failed);
    nameInput.hidden = !editable;
    nameInput.disabled = batch.running;
    nameText.hidden = editable;
    nameText.textContent = entry.name || fileName(entry.url);
    if (entry.candidate) size.textContent = formatSize(entry.candidate.size);
    else if (resourceMeta.get(entry.url)?.size) size.textContent = formatSize(resourceMeta.get(entry.url).size);
    const status = entryStatus(entry);
    badge.hidden = !entryOk(entry);
    sub.hidden = Boolean(status.text);
    state.className = `state${status.tone ? " " + status.tone : ""}`;
    state.textContent = status.text;
    state.title = status.text;
    state.hidden = !status.text;
    bar.hidden = status.progress === undefined || status.tone === "ok";
    bar.className = `progress thin${status.progress == null ? " indeterminate" : ""}`;
    bar.firstChild.style.width = `${(status.progress || 0) * 100}%`;
    // 行尾按钮只在形态变化时重建：确认页可移除、解析失败可重新解析；开始后失败可重试，被 Cloudflare 验证拦下时先打开验证。
    const retry = batch.started ? failed : entry.state === "parse-error";
    const removable = !batch.started || entryOk(entry) || failed;
    const actionKey = `${batch.started}:${retry}:${retry && Boolean(entry.challenge)}:${removable}`;
    if (entry.row.actionKey !== actionKey) {
      action.replaceChildren(...[
        retry && entry.challenge ? h("button", { type: "button", className: "btn small", title: "在新标签页打开资源，完成人机验证后回来重试",
          onclick: () => gm.openTab(entry.url) }, svg("shield", 14), "打开验证") : null,
        retry ? h("button", { type: "button", className: "icon-btn", title: batch.started ? "重试" : "重新解析", "aria-label": "重试", "data-retry": "",
          onclick: () => batch.started ? retryEntries([entry]) : void parseEntries(batch, [entry]) }, svg("retry")) : null,
        removable ? iconButton("close", batch.started ? "从列表清除" : "移除", () => batch.started ? clearEntries([entry]) : removeEntry(entry), "row-clear") : null,
      ].filter(Boolean));
      entry.row.actionKey = actionKey;
    }
    // 运行中也可以清除已结束的行；重试与重新解析要等这一轮结束。
    for (const button of action.querySelectorAll(".icon-btn:not(.row-clear)")) button.disabled = batch.running;
    return entry.row.node;
  }

  /**
   * 确认页与进度页：骨架按阶段（draft／run）只创建一次，之后原地更新计数、列表和按钮，
   * 解析结果陆续到达或轮询刷新时不会打断正在输入的文件名。
   */
  function renderBatch() {
    const target = panel && panel.dataset.view === "batch" && panel.querySelector(".batch-host");
    const footer = panel && panel.querySelector("footer");
    if (!target || !batch) return;
    const local = batch.mode === "local";
    const stage = batch.started ? "run" : "draft";
    if (target.dataset.stage !== stage || target.dataset.dest !== JSON.stringify(batch.destination)) {
      target.dataset.stage = stage;
      target.dataset.dest = JSON.stringify(batch.destination);
      footer.dataset.mode = "";
      const list = h("div", { className: "list batch-list" });
      if (!batch.started) {
        const privateNote = local
          ? "开始后会打开 Tessera 标签页接收文件，在那里解锁私密空间并确认上传；请保持两个页面打开。"
          : "解析结果会转交 Tessera 标签页，在那里解锁私密空间并确认后开始下载；解析结果 20 分钟内有效。";
        target.replaceChildren(
          destinationRow(() => batch.destination, value => { batch.destination = value; renderBatch(); }),
          h("div", { className: "section" },
            h("div", { className: "section-head" }, h("h2", {}, "保存的文件", h("span", { className: "count" }))),
            list),
          h("p", { className: "hint batch-note" }, svg(local ? "globe" : "download"), h("span", {}, batch.destination.private ? privateNote : local
            ? "由当前浏览器读取文件后上传，适合服务器被拒绝（防盗链、登录、人机验证）的资源。单文件最多 64 MiB；请保持网页打开，关闭面板后传输会继续。"
            : "由 Tessera 服务器下载，可关闭网页。文件名可直接修改；视频可在行内选择清晰度。")));
        const submit = h("button", { type: "button", className: "btn primary", onclick: () => void runBatch() },
          svg(batch.destination.private && !local ? "lock" : local ? "upload" : "send"), h("span"));
        batch.submit = submit;
        footer.replaceChildren(h("span", { className: "selection" }), h("span", { className: "spacer" }),
          h("button", { type: "button", className: "btn ghost", onclick: () => { batch = null; open(currentContext); } }, "取消"), submit);
      } else {
        batch.submit = null;
        target.replaceChildren(h("div", { className: "overview" },
          h("div", { className: "overview-line" }, h("span", { className: "status-icon" }),
            h("div", { className: "meta" }, h("strong"), h("span", { className: "sub" })),
            h("div", { className: "stats" })),
          h("div", { className: "progress" }, h("span"))), list);
      }
    }
    syncChildren(target.querySelector(".batch-list"), batch.entries.map(batchRow));
    if (!batch.started) {
      const count = target.querySelector(".count");
      count.textContent = String(batch.entries.length);
      const parsing = batch.entries.filter(entry => entry.state === "parsing").length;
      const failedParse = batch.entries.filter(entry => entry.state === "parse-error").length;
      footer.querySelector(".selection").textContent = parsing ? `正在解析 ${parsing} 项` : failedParse ? `${failedParse} 项解析失败，开始时跳过` : `${batch.entries.length} 个文件`;
      syncBatchNames();
      return;
    }
    const head = batchHeadline();
    const { ok, failed, finished } = head;
    const overview = target.querySelector(".overview");
    const handedOff = batch.destination.private;
    overview.className = `overview tone-${head.tone}`;
    const icon = overview.querySelector(".status-icon");
    if (icon.dataset.icon !== head.icon) { icon.dataset.icon = head.icon; icon.replaceChildren(svg(head.icon, 18, head.icon === "check" ? 2.6 : 2)); }
    overview.querySelector("strong").textContent = head.title;
    overview.querySelector(".sub").textContent = handedOff ? "私密空间 · 在 Tessera 页面确认" : `保存到「${destinationLabel(batch.destination)}」`;
    // 统计胶囊：数量变化时才重建。
    const stats = overview.querySelector(".stats");
    const statKey = `${ok}:${failed}:${head.running}`;
    if (stats.dataset.key !== statKey) {
      stats.dataset.key = statKey;
      stats.replaceChildren(...[
        ok ? h("span", { className: "stat ok" }, `${handedOff ? "已转交" : "成功"} ${ok}`) : null,
        failed ? h("span", { className: "stat err" }, `失败 ${failed}`) : null,
        head.running ? h("span", { className: "stat run" }, `进行中 ${head.running}`) : null,
      ].filter(Boolean));
    }
    overview.querySelector(".progress").className = head.bar;
    overview.querySelector(".progress > span").style.width = head.width;
    // 底部按钮只在形态变化时重建（运行中／结束、有无失败项），轮询不会替换正在点击的按钮。
    const failedEntries = batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry));
    const switchable = !local && finished ? failedEntries.filter(entry => !entry.platform && browserEligible(entry)) : [];
    const clearable = batch.entries.some(entry => entryOk(entry));
    const mode = `${finished ? "done" : "run"}:${failedEntries.length > 0}:${switchable.length > 0}:${Boolean(batch.running)}:${clearable}`;
    if (footer.dataset.mode === mode) { syncBatchNames(); return; }
    footer.dataset.mode = mode;
    const server = (batch.config || settings()).server.replace(/\/+$/, "");
    const link = server + (handedOff ? "/?view=private" : local ? "/?view=files" : "/?view=downloads");
    footer.replaceChildren(...[
      h("button", { type: "button", className: "btn ghost", onclick: () => gm.openTab(link) }, local || handedOff ? "查看文件" : "查看下载任务"),
      h("span", { className: "spacer" }),
      switchable.length ? h("button", { type: "button", className: "btn ghost", title: "服务器被来源拒绝时，用当前浏览器读取后上传",
        onclick: () => startBatch([...new Set(switchable.map(entry => entry.url))], "local") }, "失败项改用本地下载") : null,
      failedEntries.length ? h("button", { type: "button", className: "btn", "data-retry-failed": "", disabled: batch.running,
        onclick: () => retryEntries(batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry))) }, "重试失败项") : null,
      local && !finished ? h("button", { type: "button", className: "btn", onclick: stopBatch }, "停止") : null,
      clearable && (failedEntries.length || !finished) ? h("button", { type: "button", className: "btn ghost", title: "从列表移除已完成的项，保留失败项",
        onclick: () => clearEntries(batch.entries.filter(entryOk)) }, "清除已完成") : null,
      finished
        ? h("button", { type: "button", className: "btn primary", title: "清除这批记录并返回资源列表", onclick: clearBatch }, svg("check"), "完成")
        : h("button", { type: "button", className: "btn primary", onclick: close, title: "关闭面板，传输和进度跟踪在后台继续" }, "后台运行"),
    ].filter(Boolean));
    syncBatchNames();
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
    let dest = { path: current.destination || "", private: Boolean(current.destinationPrivate) };
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
        destination: dest.path, destinationPrivate: dest.private, cookies: cookies.checked, fab: showFab.checked,
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
        h("div", { className: "field" }, h("span", { className: "label" }, "默认保存位置"), destinationRow(() => dest, value => { dest = value; })),
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

  // X、YouTube 等单页应用换页不刷新文档：地址变化时主面板切换到新页面，已探测的资源保留（只有手动清空或刷新页面才清除）。
  // X 的图片查看器（/photo/1）不算换页。
  const pageKey = href => { try { const url = new URL(href); return url.origin + url.pathname.replace(/\/(photo|video)\/\d+\/?$/, "") + url.search; } catch { return href; } };
  let currentPage = pageKey(location.href);
  let navTimer = 0;
  function checkNavigation() {
    const key = pageKey(location.href);
    if (!active || key === currentPage) return;
    currentPage = key;
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
    navTimer = setInterval(() => checkNavigation(), 1000);
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
    clearInterval(resourcePoll);
    resourcePoll = null;
    resourceIndex = 0;
    domObserver?.disconnect();
    domObserver = null;
    document.querySelectorAll("[data-tessera-grabber]").forEach(node => node.remove());
    items.clear();
    clearedUrls.clear();
    close();
    refreshFab();
  }

  let siteMenu = null;
  function updateMenu() {
    gm.unmenu(siteMenu);
    siteMenu = null;
    if (onTessera()) return;
    siteMenu = gm.menu(active ? `在 ${currentSite()} 上停用` : `在 ${currentSite()} 上启用`, () => setSiteEnabled(!active));
  }

  function applySiteState() {
    siteEnabled() ? activate() : deactivate();
    // 没有菜单命令的管理器（iOS Userscripts）：未启用的网站也挂载一个淡化的悬浮按钮，作为重新启用与打开设置的唯一入口。
    if (!active && dormantFab()) whenReady(() => { if (!active && dormantFab()) { mount(); refreshFab(); } });
    updateMenu();
  }

  gm.menu("打开资源面板", () => open());
  gm.menu("设置", () => openSettings());
  // Tessera 站点和被排除的网站上不嗅探、不加按钮；需要时可从脚本管理器菜单（或无菜单时的淡化按钮）打开面板或设置。
  gm.load().then(() => {
    applySiteState();
    if (!SYNC_STORE) document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const before = siteEnabled();
      void gm.load().then(() => { if (siteEnabled() !== before) applySiteState(); else refreshFab(); });
    });
  });
})();
