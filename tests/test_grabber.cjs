// Run with: node --test tests/test_grabber.cjs
// Execute the real single-file userscript, stubbing only browser/GM boundaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { createHash } = require("node:crypto");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../userscripts/tessera-grabber.user.js"), "utf8");
const instrumented = source.replace(/\s+gm\.load\(\)\.then\([\s\S]*\}\);\s*\}\)\(\);\s*$/, `
  globalThis.toastMessages = [];
  toast = message => globalThis.toastMessages.push(message);
  globalThis.grabber = { browserDownload, api, cookieHeader, runBatch, retryEntries, stopBatch, parseEntries, clearEntries, clearBatch, close,
    cloudOf, cloudSources, cloudSelected, cloudShareGuide, cloudCard, resolveCloud, cloudMd5, cloudRequest, cloudDownload, captureCloudAuthorization, authorizeCloudBaidu, curlFor,
    getBatch: () => batch, setBatch: value => { batch = value; }, BROWSER_MAX_BYTES,
    pageSnapshot, addAssistantPage, assistantPages, sendAssistantPages, collect, addItem, checkNavigation, setActive: value => { active = value; },
    ready: gm.load(), gm, HAS_MENU, dormantFab, copy: text => gm.copy(text), openTab: url => gm.openTab(url),
    requestSize, wantSize, describe, noteMeta, timingSize, probeState: () => ({ probing, queued: probeQueue.length }) };
})();`);
assert.notEqual(instrumented, source, "userscript test hook must replace only final bootstrap");

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const imageResponse = () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.length) } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("transfer did not reach the expected state");
}

/** manager: "sync" 模拟 Tampermonkey／Violentmonkey（GM_*），"async" 模拟 iOS Userscripts（只有异步 GM.*，无 GM_cookie 与菜单命令）。 */
function harness({ fetch, gm, move, remove, open, cookies = true, cookieApi = true, dom, manager = "sync", isolated = false, bridge = "dom",
  url = "https://gallery.example/album", storage = {}, query, pageState = {}, documentCookie = "visible=page", gmCookies } = {}) {
  const values = { settings: { server: "https://tessera.example", key: "TEST:secret", cookies } };
  const requests = [], fetches = [], listeners = [], opened = [], copied = [];
  const window = { addEventListener(type, listener) { if (type === "message") listeners.push(listener); }, removeEventListener() {},
    open: (url, target) => open ? open(url, target, listeners) : null, fetch: async (url, options) => {
    fetches.push({ url, options });
    return fetch ? fetch(url, options) : imageResponse();
  } };
  const storageApi = { getItem: key => storage[key] == null ? null : typeof storage[key] === "string" ? storage[key] : JSON.stringify(storage[key]),
    setItem: (key, value) => { storage[key] = value; }, key: index => Object.keys(storage)[index], get length() { return Object.keys(storage).length; } };
  Object.assign(window, { localStorage: storageApi }, isolated ? {} : pageState);
  const injected = [], scriptNodes = [];
  const pageDocument = { cookie: documentCookie, querySelector: selector => query?.(selector) || null, querySelectorAll: selector => dom ? dom(selector) : [] };
  const pageContext = vm.createContext({ window: { document: pageDocument, ...pageState }, document: pageDocument });
  const makeScript = () => {
    const attributes = new Map();
    const node = { textContent: "", setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key),
      remove() { node.removed = true; attributes.clear(); } };
    if (bridge === "trusted-types") Object.defineProperty(node, "textContent", { set() { throw new TypeError("TrustedScript required"); } });
    scriptNodes.push(node);
    return node;
  };
  const inject = (node, privileged = false) => {
    injected.push(node.textContent);
    if (bridge === "blocked" || bridge === "privileged" && !privileged) return node;
    pageDocument.currentScript = node;
    try { vm.runInContext(node.textContent, pageContext); } finally { pageDocument.currentScript = null; }
    return node;
  };
  const document = isolated ? { cookie: documentCookie, querySelector: () => ({}), querySelectorAll: () => [],
    createElement: tag => { assert.equal(tag, "script"); return makeScript(); }, head: { appendChild: node => inject(node) } } : pageDocument;
  const xmlHttpRequest = details => {
    const record = { details, aborted: false };
    requests.push(record);
    queueMicrotask(() => {
      if (record.aborted) return;
      const url = new URL(details.url);
      if (url.pathname === "/api/v1/move") return move ? move(details, record)
        : details.onload({ status: 200, responseText: '{"moved":1,"skipped":0}' });
      if (url.pathname === "/api/v1/delete") return remove ? remove(details, record)
        : details.onload({ status: 200, responseText: JSON.stringify({ results: JSON.parse(details.data).paths.map(path => ({ path, deleted: true })) }) });
      if (gm) return gm(details, record);
      const data = details.method === "PUT" ? { key: url.searchParams.get("path"), size: details.data.size } : { writable: true };
      details.upload?.onprogress?.({ loaded: details.data?.size || 0 });
      details.onload({ status: 200, responseText: JSON.stringify(data) });
    });
    return { abort() { record.aborted = true; details.onabort?.(); } };
  };
  const context = vm.createContext({
    window, unsafeWindow: window, document,
    location: new URL(url), localStorage: storageApi, navigator: { userAgent: "BrowserTest/1" },
    URL, URLSearchParams, Blob, Response, ReadableStream, AbortController, btoa, atob, DOMException, TextEncoder, Uint8Array, Uint32Array, crypto: webcrypto,
    setTimeout: (fn, delay) => fn.name === "poll" ? 0 : setTimeout(fn, delay), clearTimeout, clearInterval,
    ...(manager === "sync" ? {
      GM_getValue: (key, fallback) => values[key] ?? fallback,
      GM_setValue: (key, value) => { values[key] = value; },
      GM_registerMenuCommand() {},
      GM_openInTab: url => opened.push(url),
      GM_addElement: bridge === "privileged" ? (tag, attrs) => { assert.equal(tag, "script"); return inject(Object.assign(makeScript(), attrs), true); } : undefined,
      GM_setClipboard: text => copied.push(text),
      GM_cookie: cookieApi ? { list: (_, callback) => callback(gmCookies || [{ name: "cf_clearance", value: "test-cookie", httpOnly: true }], null) } : undefined,
      GM_xmlhttpRequest: xmlHttpRequest,
    } : {
      GM: {
        getValue: async key => values[key] === undefined ? undefined : structuredClone(values[key]),
        setValue: async (key, value) => { values[key] = structuredClone(value); },
        deleteValue: async key => { delete values[key]; },
        openInTab: async url => { opened.push(url); return {}; },
        setClipboard: async text => { copied.push(text); return true; },
        // Userscripts 的 GM.xmlHttpRequest 返回带 abort 的 Promise，回调照常触发。
        xmlHttpRequest: details => Object.assign(Promise.resolve(), xmlHttpRequest(details)),
      },
    }),
  });
  vm.runInContext(instrumented, context);
  const api = context.grabber;
  const entry = (url = "https://images.example/0048.jpg", type = "image") => ({ url, type, state: "waiting", error: "", tasks: [] });
  const batch = (entries = [entry()]) => {
    const result = { mode: "local", started: false, destination: { path: "photos/", private: false }, entries };
    api.setBatch(result);
    return result;
  };
  return { api, context, pageContext, injected, scriptNodes, values, requests, fetches, opened, copied, ready: api.ready, messages: context.toastMessages, entry, batch };
}

test("browser image upload preserves bytes and isolates credentials", async () => {
  const h = harness();
  const current = h.batch();
  await h.api.runBatch();
  const entry = current.entries[0];
  assert.equal(entry.state, "completed");
  assert.equal(entry.path, "photos/0048.jpg");
  assert.match(entry.stagePath, /^photos\/\.tessera-upload-[a-f\d]{16}$/);
  assert.equal(h.fetches[0].options.credentials, "include");
  assert.equal(h.fetches[0].options.cache, "force-cache");
  assert.equal(h.fetches[0].options.headers, undefined);
  const upload = h.requests.find(request => request.details.method === "PUT").details;
  assert.equal(upload.url, `https://tessera.example/api/v1/files?path=${encodeURIComponent(entry.stagePath)}`);
  assert.equal(upload.headers.Authorization, "Bearer TEST:secret");
  assert.equal(upload.headers["Content-Type"], "image/png");
  assert.equal(upload.headers.Cookie, undefined);
  assert.equal(upload.cookie, undefined);
  assert.equal(upload.anonymous, true);
  assert.deepEqual(new Uint8Array(await upload.data.arrayBuffer()), png);
  const move = h.requests.find(request => request.details.url.endsWith("/move")).details;
  assert.deepEqual(JSON.parse(move.data), { from: entry.stagePath, to: entry.path, conflict: "skip" });
  assert.deepEqual(Array.from(h.values.sent), [entry.url]);
  assert.equal(h.requests.some(request => request.details.url.includes("/downloads")), false);
});

test("cross-origin fallback uses source cookies without Tessera authorization", async () => {
  const h = harness({ fetch: () => { throw new TypeError("CORS"); }, gm: details => {
    if (details.url.startsWith("https://tessera.example")) {
      details.onload({ status: 200, responseText: JSON.stringify(details.method === "PUT"
        ? { key: new URL(details.url).searchParams.get("path"), size: details.data.size } : { writable: true }) });
    } else details.onload({ status: 200, responseHeaders: "Content-Type: image/png\r\n", response: new Blob([png]) });
  } });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "completed");
  const source = h.requests.find(request => request.details.url.startsWith("https://images.example")).details;
  assert.equal(source.cookie, "cf_clearance=test-cookie");
  assert.equal(source.anonymous, false);
  assert.equal(source.responseType, "blob");
  assert.equal(source.headers.Authorization, undefined);
  assert.equal(source.headers.Referer, "https://gallery.example/album");
});

test("disabled cookies apply to both page requests and extension fallback", async () => {
  const h = harness({ cookies: false, fetch: () => { throw new TypeError("CORS"); }, gm: details => {
    details.onload({ status: 200, responseHeaders: "Content-Type: image/png", response: new Blob([png]) });
  } });
  await h.api.browserDownload("https://images.example/a.png", "image", {
    signal: new AbortController().signal, cookies: false, onprogress() {},
  });
  assert.equal(h.fetches[0].options.credentials, "omit");
  assert.equal(h.requests[0].details.anonymous, true);
  assert.equal(h.requests[0].details.cookie, undefined);
});

test("document.cookie fallback never crosses hostname boundaries", async () => {
  const h = harness({ cookieApi: false });
  assert.equal(await h.api.cookieHeader("https://gallery.example/image.png"), "visible=page");
  assert.equal(await h.api.cookieHeader("https://evilgallery.example/image.png"), "");
  assert.equal(await h.api.cookieHeader("https://images.gallery.example/image.png"), "");
});

for (const [label, response] of [
  ["Cloudflare HTML with status 200", () => new Response("<!DOCTYPE html><html><title>Just a moment...</title></html>", { headers: { "Content-Type": "text/html" } })],
  ["HTML disguised as image", () => new Response("<!DOCTYPE html><html>login</html>", { headers: { "Content-Type": "image/jpeg" } })],
  ["challenge header with image bytes", () => new Response(png, { headers: { "Content-Type": "image/png", "cf-mitigated": "challenge" } })],
  ["JSON in place of an image", () => new Response('{"error":"login required"}', { headers: { "Content-Type": "application/json" } })],
  ["JSON disguised as image", () => new Response('{"error":"login required"}', { headers: { "Content-Type": "image/jpeg" } })],
  ["stream playlist behind an image URL", () => new Response("#EXTM3U\n#EXTINF:10", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } })],
]) test(`reject ${label} before any upload`, async () => {
  const h = harness({ fetch: response });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "error");
  assert.equal(h.requests.some(request => request.details.method === "PUT"), false);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("page 403 tries extension once and reports both refusals", async () => {
  const h = harness({ fetch: () => new Response("blocked", { status: 403 }), gm: details => details.onload(
    details.url.startsWith("https://tessera.example") ? { status: 200, responseText: '{"writable":true}' } : { status: 403 }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.match(current.entries[0].error, /HTTP 403/);
  assert.match(current.entries[0].error, /网页请求.*扩展请求/);
  assert.equal(h.requests.length, 2); // destination preflight + one source request
  assert.equal(h.requests.some(request => request.details.method === "PUT"), false);
});

test("page 403 can fall back to extension cookies and headers", async () => {
  const h = harness({ fetch: () => new Response("blocked", { status: 403 }), gm: details => details.onload(
    details.url.startsWith("https://tessera.example")
      ? { status: 200, responseText: JSON.stringify(details.method === "PUT"
        ? { key: new URL(details.url).searchParams.get("path"), size: details.data.size } : { writable: true }) }
      : { status: 200, responseHeaders: "Content-Type: image/png", response: new Blob([png]) }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "completed");
  const source = h.requests.find(request => request.details.url.startsWith("https://images.example")).details;
  assert.equal(source.cookie, "cf_clearance=test-cookie");
  assert.equal(source.headers.Authorization, undefined);
});

test("page 401 remains a login failure without replay", async () => {
  const h = harness({ fetch: () => new Response("login", { status: 401 }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.match(current.entries[0].error, /HTTP 401/);
  assert.equal(h.requests.length, 1);
});

test("save the chosen Unicode filename without random suffix", async () => {
  const h = harness();
  const current = h.batch();
  current.entries[0].name = "我的原图.jpg";
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "completed");
  assert.equal(current.entries[0].path, "photos/我的原图.jpg");
});

test("append extension from actual content only when the chosen name has none", async () => {
  const h = harness();
  const current = h.batch();
  current.entries[0].name = "封面";
  await h.api.runBatch();
  assert.equal(current.entries[0].path, "photos/封面.png");
});

for (const name of ["", "../outside.jpg", "nested/a.jpg", "nested\\a.jpg", ".", "..", ".tgdrive", "a\u0000.jpg", "a.", "图".repeat(74)]) {
  test(`reject unsafe or invalid save name ${JSON.stringify(name)} before any request`, async () => {
    const h = harness();
    const current = h.batch();
    current.entries[0].name = name;
    await h.api.runBatch();
    assert.equal(current.started, false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.fetches.length, 0);
    assert.ok(h.messages.length);
  });
}

test("duplicate normalized names cannot start a batch", async () => {
  const h = harness();
  const current = h.batch([h.entry("https://images.example/a.jpg"), h.entry("https://images.example/b.jpg")]);
  current.entries[0].name = " cafe\u0301.jpg ";
  current.entries[1].name = "caf\u00e9.jpg";
  await h.api.runBatch();
  assert.match(h.messages[0], /重复/);
  assert.equal(current.started, false);
  assert.equal(h.fetches.length, 0);
});

test("same-name collision keeps original and deletes only its own staged upload", async () => {
  const h = harness({ move: details => details.onload({ status: 200, responseText: '{"moved":0,"skipped":1}' }) });
  const current = h.batch();
  const entry = current.entries[0];
  entry.name = "existing.jpg";
  await h.api.runBatch();
  assert.equal(entry.state, "error");
  assert.match(entry.error, /已保留原文件/);
  const put = h.requests.find(request => request.details.method === "PUT").details;
  assert.notEqual(new URL(put.url).searchParams.get("path"), "photos/existing.jpg");
  const cleanup = h.requests.find(request => request.details.url.endsWith("/delete")).details;
  assert.deepEqual(JSON.parse(cleanup.data).paths, [entry.stagePath]);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("rename a failed collision before retry and reuse its staging path", async () => {
  let moves = 0;
  const h = harness({ move: details => details.onload({ status: 200, responseText: ++moves === 1 ? '{"moved":0,"skipped":1}' : '{"moved":1,"skipped":0}' }) });
  const current = h.batch();
  const entry = current.entries[0];
  await h.api.runBatch();
  const stage = entry.stagePath;
  entry.name = "renamed.jpg";
  entry.path = null;
  h.api.retryEntries([entry]);
  await until(() => !current.running);
  assert.equal(entry.state, "completed");
  assert.equal(entry.path, "photos/renamed.jpg");
  assert.equal(entry.stagePath, stage);
});

test("move failure cannot mark staged bytes as successfully saved", async () => {
  const h = harness({ move: details => details.onload({ status: 500, responseText: '{"error":{"message":"move failed"}}' }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "error");
  assert.equal(h.requests.some(request => request.details.url.endsWith("/delete")), true);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("client timeout aborts GM request even without native timeout events", async () => {
  const h = harness({ gm() {} });
  await assert.rejects(h.api.api("POST", "/api/v1/test", {}, { timeout: 5 }), /超时/);
  assert.equal(h.requests[0].aborted, true);
});

test("reject declared oversize and cancel the response before reading bytes", async () => {
  let cancelled = false;
  const h = harness({ fetch: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
  }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.match(current.entries[0].error, /64 MiB/);
  assert.equal(cancelled, true);
  assert.equal(h.requests.some(request => request.details.method === "PUT"), false);
});

test("unknown-length source stops at size limit and cancels its stream", async () => {
  let cancelled = false;
  const h = harness({ fetch: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })) });
  const current = h.batch();
  await h.api.runBatch();
  assert.match(current.entries[0].error, /64 MiB/);
  assert.equal(cancelled, true);
  assert.equal(h.requests.some(request => request.details.method === "PUT"), false);
});

test("extension download aborts at declared size limit", async () => {
  const h = harness({ fetch: () => { throw new TypeError("CORS"); }, gm: details => {
    details.onprogress({ loaded: 1, total: 64 * 1024 * 1024 + 1, lengthComputable: true });
  } });
  await assert.rejects(h.api.browserDownload("https://images.example/a.jpg", "image", {
    signal: new AbortController().signal, cookies: true, onprogress() {},
  }), /64 MiB/);
  assert.equal(h.requests[0].aborted, true);
});

test("read-only destination fails before downloading the source", async () => {
  const h = harness({ gm: details => details.onload({ status: 200, responseText: '{"writable":false}' }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.match(current.entries[0].error, /不能写入/);
  assert.equal(h.fetches.length, 0);
});

test("browser mode hands private-space files to the Tessera page instead of the key API", async () => {
  const posted = [];
  let opened = "";
  const h = harness({ open: (url, target, listeners) => {
    opened = url;
    const nonce = /#receive=([a-f\d]+)&/.exec(url)[1];
    const reply = data => listeners.forEach(listener => listener({ origin: "https://tessera.example", data: { source: "tessera", nonce, ...data } }));
    queueMicrotask(() => reply({ type: "transfer-ready" }));
    return { closed: false, postMessage(data, origin) {
      posted.push({ data, origin });
      if (data.type === "file") queueMicrotask(() => reply({ type: "transfer-ack", index: data.index, ok: true }));
    } };
  } });
  const current = h.batch();
  current.destination = { path: "", private: true };
  await h.api.runBatch();
  await until(() => posted.some(message => message.data.type === "end"));
  const entry = current.entries[0];
  assert.equal(entry.state, "handoff");
  assert.equal(entry.delivered, true);
  assert.match(opened, /^https:\/\/tessera\.example\/\?view=private#receive=[a-f\d]{36}&from=https%3A%2F%2Fgallery\.example$/);
  const file = posted.find(message => message.data.type === "file");
  assert.equal(file.origin, "https://tessera.example");
  assert.equal(file.data.name, "0048.jpg");
  assert.deepEqual(new Uint8Array(await file.data.blob.arrayBuffer()), png);
  // 私密空间不经过访问密钥：没有目录检查、上传或移动请求。
  assert.equal(h.requests.some(request => request.details.url.startsWith("https://tessera.example")), false);
});

test("blocked popup fails the private transfer before downloading", async () => {
  const h = harness();
  const current = h.batch();
  current.destination = { path: "", private: true };
  await h.api.runBatch();
  assert.match(current.entries[0].error, /拦截了新标签页/);
  assert.equal(h.fetches.length, 0);
});

test("Cloudflare challenge is reported so the user can verify in a tab", async () => {
  const h = harness({ fetch: () => { throw new TypeError("CORS"); }, gm: details => {
    if (details.url.startsWith("https://tessera.example")) return details.onload({ status: 200, responseText: '{"writable":true}' });
    details.onload({ status: 403, responseHeaders: "Server: cloudflare\r\ncf-mitigated: challenge\r\n", response: new Blob(["<title>Just a moment...</title>"]) });
  } });
  const current = h.batch();
  await h.api.runBatch();
  const entry = current.entries[0];
  assert.equal(entry.state, "error");
  assert.equal(entry.challenge, true);
  assert.match(entry.error, /人机验证/);
  const source = h.requests.find(request => request.details.url.startsWith("https://images.example")).details;
  assert.equal(source.headers["User-Agent"], undefined);
  assert.match(source.headers.Accept, /^image\//);
});

test("browser mode processes one file at a time", async () => {
  let active = 0, peak = 0;
  const h = harness({ fetch: async () => {
    peak = Math.max(peak, ++active);
    await tick();
    --active;
    return imageResponse();
  } });
  const current = h.batch([h.entry("https://images.example/a.png"), h.entry("https://images.example/b.png")]);
  await h.api.runBatch();
  assert.equal(peak, 1);
  assert.equal(current.entries.every(entry => entry.state === "completed"), true);
});

test("stop aborts active source and prevents queued uploads", async () => {
  const h = harness({ fetch: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) });
  const current = h.batch([h.entry("https://images.example/a.png"), h.entry("https://images.example/b.png")]);
  const running = h.api.runBatch();
  await tick();
  h.api.stopBatch();
  await running;
  assert.equal(current.entries.every(entry => entry.state === "stopped"), true);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.requests.some(request => request.details.method === "PUT"), false);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("stop aborts active upload; late callbacks cannot mark it sent", async () => {
  let upload;
  const h = harness({ gm: details => {
    if (details.method === "PUT") { upload = details; return; }
    details.onload({ status: 200, responseText: '{"writable":true}' });
  } });
  const current = h.batch();
  const running = h.api.runBatch();
  await until(() => Boolean(upload));
  h.api.stopBatch();
  await running;
  upload.onload({ status: 200, responseText: JSON.stringify({ key: current.entries[0].path, size: png.length }) });
  await tick();
  assert.equal(current.entries[0].state, "stopped");
  assert.equal(h.requests.find(request => request.details.method === "PUT").aborted, true);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("retry reuses destination path and marks sent only after confirmed storage", async () => {
  let uploads = 0;
  const h = harness({ gm: details => {
    if (details.method !== "PUT") return details.onload({ status: 200, responseText: '{"writable":true}' });
    if (++uploads === 1) return details.onload({ status: 503, responseText: '{"error":{"message":"try again"}}' });
    details.onload({ status: 200, responseText: JSON.stringify({ key: new URL(details.url).searchParams.get("path"), size: details.data.size }) });
  } });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "error");
  assert.deepEqual(Array.from(h.values.sent || []), []);
  const target = current.entries[0].path;
  h.api.retryEntries(current.entries);
  await until(() => !current.running);
  assert.equal(current.entries[0].state, "completed");
  assert.equal(current.entries[0].path, target);
  assert.equal(uploads, 2);
});

test("successful HTTP response without storage acknowledgement remains failed", async () => {
  const h = harness({ gm: details => details.onload({ status: 200, responseText: details.method === "PUT" ? "<html>login</html>" : '{"writable":true}' }) });
  const current = h.batch();
  await h.api.runBatch();
  assert.equal(current.entries[0].state, "error");
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("binary JSON files are not JSON-stringified by the upload wrapper", async () => {
  const h = harness();
  const blob = new Blob(['{"a":1}'], { type: "application/json" });
  await h.api.api("PUT", "/api/v1/files?path=a.json", blob, { binary: true, contentType: "application/json" });
  assert.equal(h.requests[0].details.data, blob);
});

test("closing panel leaves transfer running with its original server and key", async () => {
  let resume;
  const h = harness({ fetch: () => new Promise(resolve => { resume = () => resolve(imageResponse()); }) });
  const current = h.batch();
  const running = h.api.runBatch();
  await tick();
  h.api.close();
  h.values.settings = { server: "https://changed.example", key: "NEW:secret", cookies: false };
  resume();
  await running;
  const upload = h.requests.find(request => request.details.method === "PUT").details;
  assert.equal(current.entries[0].state, "completed");
  assert.equal(new URL(upload.url).origin, "https://tessera.example");
  assert.equal(upload.headers.Authorization, "Bearer TEST:secret");
});

const parseResponse = { candidates: [
  { ticket: "t-720", name: "clip.mp4", group: "v", variant: "720p", size: 10 },
  { ticket: "t-1080", name: "clip-1080.mp4", group: "v", variant: "1080p", size: 20 },
  { ticket: "t-img", name: "cover.jpg", group: "i", size: 5 },
] };

test("server mode parses first: one row per group with variants and editable names", async () => {
  const h = harness({ gm: details => details.onload({ status: 200, responseText: JSON.stringify(
    details.url.endsWith("/parse") ? parseResponse : { tasks: [{ id: 7, status: "queued", key: "photos/x" }] }) }) });
  const current = h.batch([{ url: "https://cdn.example/clip.m3u8", type: "stream", state: "parsing", error: "", tasks: [], platform: null }]);
  current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  assert.equal(current.entries.length, 2);
  const [video, image] = current.entries;
  assert.equal(video.state, "waiting");
  assert.equal(video.variants.length, 2);
  assert.equal(video.candidate.ticket, "t-720");
  assert.equal(video.type, "video");
  assert.equal(image.type, "image");
  video.candidate = video.variants[1];
  video.name = "我的视频.mp4";
  await h.api.runBatch();
  const creates = h.requests.filter(request => new URL(request.details.url).pathname === "/api/v1/downloads");
  assert.deepEqual(creates.map(request => JSON.parse(request.details.data)), [
    { items: [{ ticket: "t-1080", name: "我的视频.mp4" }], destination: "photos/" },
    { items: [{ ticket: "t-img", name: "cover.jpg" }], destination: "photos/" },
  ]);
  assert.equal(video.state, "submitted");
  assert.equal(h.fetches.length, 0);
});

test("server mode to private space hands renamed candidates to the Tessera page", async () => {
  const h = harness({ gm: details => details.onload({ status: 200, responseText: JSON.stringify(parseResponse) }) });
  const current = h.batch([{ url: "https://cdn.example/clip.m3u8", type: "stream", state: "parsing", error: "", tasks: [], platform: null }]);
  current.mode = "server";
  current.destination = { path: "", private: true };
  await h.api.parseEntries(current, current.entries.slice());
  current.entries[1].name = "封面.jpg";
  await h.api.runBatch();
  assert.equal(h.opened.length, 1);
  const match = /\/\?view=downloads#import=([\w-]+)$/.exec(h.opened[0]);
  const json = JSON.parse(Buffer.from(match[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  assert.equal(json.private, true);
  assert.deepEqual(json.candidates.map(item => [item.ticket, item.name]), [["t-720", "clip.mp4"], ["t-img", "封面.jpg"]]);
  assert.equal(h.requests.some(request => request.details.url.endsWith("/api/v1/downloads")), false);
  assert.ok(current.entries.every(entry => entry.state === "handoff"));
});

test("server parse failure is skipped at start and can be re-parsed", async () => {
  let fail = true;
  const h = harness({ gm: details => {
    if (details.url.endsWith("/parse") && fail) return details.onload({ status: 400, responseText: '{"error":{"message":"来源拒绝"}}' });
    details.onload({ status: 200, responseText: JSON.stringify(details.url.endsWith("/parse") ? { candidates: [parseResponse.candidates[2]] } : { tasks: [{ id: 9, status: "queued" }] }) });
  } });
  const current = h.batch([
    { url: "https://cdn.example/a.jpg", type: "image", state: "parsing", error: "", tasks: [], platform: null },
  ]);
  current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  assert.equal(current.entries[0].state, "parse-error");
  assert.match(current.entries[0].error, /来源拒绝/);
  fail = false;
  await h.api.retryEntries([current.entries[0]]);
  await until(() => current.entries[0].state === "submitted");
  assert.equal(current.entries[0].candidate.ticket, "t-img");
});

test("finished rows can be cleared; clearing the last row drops the batch", async () => {
  const h = harness();
  const current = h.batch([h.entry("https://images.example/a.jpg"), h.entry("https://images.example/b.jpg")]);
  await h.api.runBatch();
  assert.ok(current.entries.every(entry => entry.state === "completed"));
  h.api.clearEntries([current.entries[0]]);
  assert.equal(current.entries.length, 1);
  assert.equal(h.api.getBatch(), current);
  h.api.clearEntries([current.entries[0]]);
  assert.equal(h.api.getBatch(), null);
  // 已保存的文件不受影响：清除不会发出任何删除请求。
  assert.equal(h.requests.some(request => request.details.url.endsWith("/delete")), false);
});

test("a running batch cannot be cleared", () => {
  const h = harness();
  const current = h.batch();
  current.started = true;
  current.entries[0].state = "downloading";
  h.api.clearBatch();
  assert.equal(h.api.getBatch(), current);
  assert.match(h.messages.at(-1), /还有文件在传输/);
});


// ---------- 发给文件助手 ----------

function element(tag, attrs = {}, parent = null, extra = {}) {
  return { nodeType: 1, tagName: tag.toUpperCase(), parentElement: parent, getAttribute: name => attrs[name] ?? null,
    closest: selector => { for (let node = parent; node; node = node.parentElement) if (node.tagName === "A" && node.getAttribute("href")) return node; return null; },
    ...extra };
}

test("page snapshot clusters images by element path and keeps only pagination links", () => {
  const h = harness();
  const html = element("html");
  const body = element("body", {}, html);
  const grid = element("div", { class: "gallery grid-3" }, body);
  const link1 = element("a", { href: "/full/1.jpg", class: "item-12" }, grid);
  const link2 = element("a", { href: "/full/2.jpg", class: "item-13" }, grid);
  const doc = {
    title: "  相册  第 1 页 ",
    images: [
      element("img", { class: "thumb", src: "/t/1.jpg", srcset: "/s/1.jpg 400w, /l/1.jpg 1600w" }, link1, { currentSrc: "https://gallery.example/s/1.jpg", naturalWidth: 400, naturalHeight: 300 }),
      element("img", { class: "thumb", "data-src": "/lazy/2.jpg", src: "data:image/gif;base64,R0lGOD" }, link2, { naturalWidth: 0 }),
      element("img", { class: "icon", src: "/i.png" }, body, { naturalWidth: 16, naturalHeight: 16 }),
    ],
    querySelectorAll: () => [
      element("a", { href: "/album?page=2", class: "next" }, body, { textContent: " 下一页 " }),
      element("a", { href: "/about" }, body, { textContent: "关于我们" }),
      element("a", { href: "/album?page=3" }, body, { textContent: "3" }),
    ],
  };
  const snapshot = h.api.pageSnapshot(doc, "https://gallery.example/album?page=1");
  assert.equal(snapshot.title, "相册 第 1 页");
  assert.equal(snapshot.images.length, 2, "tiny icons are skipped");
  assert.equal(snapshot.images[0].path, "body>div.gallery>a.item-*>img.thumb");
  assert.equal(snapshot.images[1].path, snapshot.images[0].path, "numeric class suffixes cluster together");
  assert.equal(snapshot.images[0].urls.srcset, "https://gallery.example/l/1.jpg");
  assert.equal(snapshot.images[0].urls.href, "https://gallery.example/full/1.jpg");
  assert.equal(snapshot.images[1].urls["data-src"], "https://gallery.example/lazy/2.jpg");
  assert.equal(snapshot.images[1].urls.src, undefined, "data: URLs are dropped");
  assert.equal(snapshot.links.map(link => link.text).join("|"), "下一页|3");
});

test("assistant page storage enforces limits, origin and expiry", () => {
  const h = harness();
  const page = (n, images = 1) => ({ url: `https://gallery.example/p/${n}`, title: "", images: Array.from({ length: images }, (_, i) => ({ path: "img", urls: { src: `https://cdn.example/${n}-${i}.jpg` } })), links: [] });
  h.api.addAssistantPage(page(1));
  h.api.addAssistantPage(page(1));
  assert.equal(h.api.assistantPages().length, 1, "same URL replaces the stored page");
  h.api.addAssistantPage(page(2));
  assert.equal(h.api.assistantPages().length, 2);
  assert.equal(h.api.assistantPages("https://other.example").length, 0, "other origins do not see the pages");
  assert.throws(() => h.api.addAssistantPage(page(3, 5000)), /图片候选/);
  h.values["assistant-pages"].savedAt -= 25 * 3600 * 1000;
  assert.equal(h.api.assistantPages().length, 0, "pages expire after 24 hours");
});

test("sending pages waits for the Tessera page and verifies origin and nonce", async () => {
  let posted = [];
  let listenersRef;
  const tab = { closed: false, postMessage: (message, origin) => posted.push({ message, origin }) };
  const h = harness({ open: (url, target, listeners) => { listenersRef = listeners; tab.url = url; return tab; } });
  const pages = [{ url: "https://gallery.example/album", title: "", images: [{ path: "img", urls: { src: "https://cdn.example/1.jpg" } }], links: [] }];
  const done = h.api.sendAssistantPages("https://tessera.example/", pages);
  const nonce = /assistant-page=([0-9a-f]+)&from=https%3A%2F%2Fgallery.example/.exec(tab.url)[1];
  const emit = (origin, data) => listenersRef.forEach(listener => listener({ origin, data }));
  emit("https://evil.example", { source: "tessera", nonce, type: "page-ready" });
  emit("https://tessera.example", { source: "tessera", nonce: "wrong", type: "page-ready" });
  assert.equal(posted.length, 0, "foreign origins and nonces are ignored");
  emit("https://tessera.example", { source: "tessera", nonce, type: "page-ready" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, "https://tessera.example");
  assert.equal(posted[0].message.type, "page-snapshot");
  assert.equal(posted[0].message.pages.length, 1);
  emit("https://tessera.example", { source: "tessera", nonce, type: "page-ack", ok: true });
  await done;
});

test("detected resources accumulate across popups and page changes until cleared manually", () => {
  // 网页每点一个标签弹出一组图片：上一组离开 DOM、地址也可能变化，已探测的资源都要保留，便于一次发送多组。
  let images = [];
  const img = src => ({ currentSrc: src, src, naturalWidth: 1200, naturalHeight: 800 });
  const h = harness({ dom: selector => selector === "img" ? images : [] });
  const urls = () => [...h.api.collect()].map(item => item.url).sort();
  images = [1, 2, 3].map(n => img(`https://charts.example/a-${n}.png`));
  assert.equal(urls().length, 3);
  images = [1, 2, 3].map(n => img(`https://charts.example/b-${n}.png`));
  assert.equal(urls().length, 6, "上一个弹窗的图片离开 DOM 后仍保留");
  h.api.addItem("https://cdn.example/clip.mp4", "video", { source: "网络" });
  h.api.setActive(true);
  h.context.location.href = "https://gallery.example/album?tab=2";
  h.api.checkNavigation();
  images = [];
  assert.deepEqual(urls(), [
    "https://cdn.example/clip.mp4",
    ...[1, 2, 3].map(n => `https://charts.example/a-${n}.png`),
    ...[1, 2, 3].map(n => `https://charts.example/b-${n}.png`),
  ].sort(), "单页应用换页不清除已探测的资源");
  h.api.setActive(false);
});

// ---------- iOS Userscripts（只有异步 GM.*）：关键流程与 Tampermonkey 环境一致 ----------

test("async GM: settings preload, browser upload and sent records persist through GM.setValue", async () => {
  const h = harness({ manager: "async" });
  await h.ready;
  assert.equal(h.api.HAS_MENU, false);
  assert.equal(h.api.dormantFab(), true);
  const current = h.batch();
  await h.api.runBatch();
  const entry = current.entries[0];
  assert.equal(entry.state, "completed");
  const upload = h.requests.find(request => request.details.method === "PUT").details;
  assert.equal(upload.headers.Authorization, "Bearer TEST:secret");
  assert.deepEqual(new Uint8Array(await upload.data.arrayBuffer()), png);
  await tick();
  assert.deepEqual(Array.from(h.values.sent), [entry.url]);
});

test("async GM: server mode parses and creates download tasks", async () => {
  const h = harness({ manager: "async", gm: details => details.onload({ status: 200, responseText: JSON.stringify(
    details.url.endsWith("/parse") ? parseResponse : { tasks: [{ id: 7, status: "queued", key: "photos/x" }] }) }) });
  await h.ready;
  const current = h.batch([{ url: "https://cdn.example/clip.m3u8", type: "stream", state: "parsing", error: "", tasks: [], platform: null }]);
  current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  await h.api.runBatch();
  const creates = h.requests.filter(request => new URL(request.details.url).pathname === "/api/v1/downloads");
  assert.equal(creates.length, 2);
  assert.equal(current.entries[0].state, "submitted");
});

test("async GM: without GM_cookie only same-host document cookies are used", async () => {
  const h = harness({ manager: "async" });
  await h.ready;
  assert.equal(await h.api.cookieHeader("https://gallery.example/image.png"), "visible=page");
  assert.equal(await h.api.cookieHeader("https://cdn.example/image.png"), "");
});

test("async GM: tabs, clipboard and stopping an upload use the GM.* API", async () => {
  let upload;
  const h = harness({ manager: "async", gm: details => {
    if (details.method === "PUT") { upload = details; return; }
    details.onload({ status: 200, responseText: '{"writable":true}' });
  } });
  await h.ready;
  h.api.openTab("https://tessera.example/?view=downloads");
  h.api.copy("curl 'https://cdn.example/a.mp4'");
  await tick();
  assert.deepEqual(h.opened, ["https://tessera.example/?view=downloads"]);
  assert.deepEqual(h.copied, ["curl 'https://cdn.example/a.mp4'"]);
  const current = h.batch();
  const running = h.api.runBatch();
  await until(() => Boolean(upload));
  h.api.stopBatch();
  await running;
  assert.equal(current.entries[0].state, "stopped");
  assert.equal(h.requests.find(request => request.details.method === "PUT").aborted, true);
  assert.deepEqual(Array.from(h.values.sent || []), []);
});

test("sync GM: settings and clipboard keep using GM_* directly", async () => {
  const h = harness();
  await h.ready;
  assert.equal(h.api.HAS_MENU, true);
  assert.equal(h.api.dormantFab(), false);
  h.api.copy("text");
  assert.deepEqual(h.copied, ["text"]);
});

for (const manager of ["sync", "async"]) {
  test(`resource sizes come from timing, HEAD, or a one-byte range probe (${manager})`, async () => {
    const seen = [];
    const h = harness({ manager, gm: (details, record) => {
      seen.push({ method: details.method, url: details.url, headers: details.headers });
      const url = new URL(details.url);
      if (url.pathname === "/head.mp4") return details.onload({ status: 200, readyState: 4, responseHeaders: "content-type: video/mp4\r\ncontent-length: 1048576\r\n" });
      if (url.pathname === "/range.zip") {
        if (details.method === "HEAD") return details.onload({ status: 405, readyState: 4, responseHeaders: "" });
        // 响应头一到就读出总大小并中止，不下载内容。
        return details.onreadystatechange({ status: 206, readyState: 2, responseHeaders: "content-range: bytes 0-0/5000\r\ncontent-length: 1\r\n" });
      }
      details.onload({ status: 403, readyState: 4, responseHeaders: "server: cloudflare\r\n" });
    } });
    await h.ready;
    assert.equal(h.api.timingSize({ decodedBodySize: 2048 }, "image"), 2048);
    assert.equal(h.api.timingSize({ decodedBodySize: 2048 }, "video"), 0, "media timing only covers a loaded range");
    h.api.noteMeta("https://cdn.example/a.jpg", 2048, [1920, 1080]);
    assert.equal(h.api.describe({ url: "https://cdn.example/a.jpg", type: "image" }), "图片 · 2.0 KB · 1920×1080 · cdn.example");
    assert.equal(await h.api.requestSize("https://media.example/head.mp4"), 1048576);
    assert.equal(await h.api.requestSize("https://files.example/range.zip"), 5000);
    assert.equal(await h.api.requestSize("https://blocked.example/x.bin"), 0);
    assert.deepEqual(seen.filter(item => item.url.includes("range.zip")).map(item => item.method), ["HEAD", "GET"]);
    assert.equal(seen.find(item => item.method === "GET").headers.Range, "bytes=0-0");
    for (const request of seen) {
      assert.equal(request.headers?.Authorization, undefined, "Tessera key must not reach the source");
      assert.equal(request.headers?.["User-Agent"], undefined);
    }
    const range = h.requests.find(request => request.details.url.includes("range.zip") && request.details.method === "GET");
    assert.equal(range.aborted, true, "range probe stops after headers");
  });
}

test("size probing runs at most three requests and skips playlists", async () => {
  const pending = [];
  const h = harness({ gm: details => { pending.push(details); } });
  for (let i = 0; i < 5; i++) h.api.wantSize({ url: `https://media.example/${i}.mp4`, type: "video" });
  h.api.wantSize({ url: "https://media.example/list.m3u8", type: "stream" });
  h.api.wantSize({ url: "https://media.example/0.mp4", type: "video" });
  await until(() => pending.length === 3);
  const state = h.api.probeState();
  assert.equal(state.probing, 3);
  assert.equal(state.queued, 2);
  pending[0].onload({ status: 200, readyState: 4, responseHeaders: "content-length: 10\r\n" });
  await until(() => pending.length === 4);
  assert.ok(!pending.some(details => details.url.includes("m3u8")));
  assert.equal(pending.filter(details => details.url.endsWith("/0.mp4")).length, 1, "each address is probed once");
  assert.equal(h.api.describe({ url: "https://media.example/0.mp4", type: "video" }), "视频 · 10 B · media.example");
});

// Cloud fixtures model the provider page's actual Vue/React selection boundaries. No provider is contacted.
const reactSelection = props => ({ __reactFiber$fixture: { type: "div", return: { type() {}, pendingProps: props } } });
const jsonReply = (details, value, extra = {}) => details.onload({ status: 200, responseText: JSON.stringify(value), ...extra });
const md5 = value => createHash("md5").update(value).digest("hex");
function cloudFixture(provider) {
  const name = `来自 ${provider} 的'原文件'.bin`;
  const vue = selectedList => ({ __vue__: { selectedList } });
  const tokenStorage = { credentials_client: { token_type: "Bearer", access_token: "SOURCE_TOKEN", user_id: "user", expires_at: "2099-01-01" },
    captcha_client: { token: "SOURCE_CAPTCHA", captcha_token: "SOURCE_CAPTCHA", expires_at: "2099-01-01" }, deviceid: "0123456789abcdef0123456789abcdef" };
  const fixtures = {
    baidu: { url: "https://pan.baidu.com/disk/main", query: selector => selector === ".wp-s-core-pan" ? vue([
      { fs_id: 101, server_filename: name, size: 42, isdir: 0 }, { fs_id: 102, server_filename: "folder", isdir: 1, path: "/empty" },
    ]) : null },
    aliyun: { url: "https://www.alipan.com/drive/file/all", storage: { token: { token_type: "Bearer", access_token: "ALI_TOKEN" } },
      query: selector => selector.startsWith('[class^="node-list-table-view--"]') ? reactSelection({ selectedKeys: "a1", dataSource: [
        { fileId: "a1", driveId: "drive1", name, size: 42, type: "file" }, { fileId: "a2", name: "other", type: "file" },
      ] }) : null },
    mcloud: { url: "https://yun.139.com/w/#/main", documentCookie: "authorization=Bearer%20MOBILE_TOKEN", query: selector => selector === ".main_file_list"
      ? { __vue__: { selectList: [{ item: { contentID: "m1", contentName: name, contentSize: 42 } }] } } : null },
    tcloud: { url: "https://cloud.189.cn/web/main", query: selector => selector === ".c-file-list" ? vue([{ fileId: "t1", fileName: name, size: 42, isFolder: false }]) : null },
    xunlei: { url: "https://pan.xunlei.com/", storage: tokenStorage, dom: selector => selector.includes("SourceListItem")
      ? [{ __vue__: { selected: ["x1"], info: { id: "x1", name, size: 42, kind: "drive#file" } } }] : [] },
    guangya: { url: "https://www.guangyapan.com/", storage: tokenStorage, query: selector => selector.startsWith(".swangpan-file-list")
      ? reactSelection({ dataSource: [{ fileId: "g1", fileName: name, fileSize: 42, resType: 1 }], selectedItems: ["g1"] }) : null },
    quark: { url: "https://pan.quark.cn/list/all", documentCookie: "__pugs=SOURCE_COOKIE", gmCookies: [{ name: "__pugs", value: "SOURCE_COOKIE" }], query: selector => selector === ".file-list"
      ? reactSelection({ list: [{ fid: "q1", file_name: name, size: 42, file: true }, { fid: "folder", file: false }], selectedRowKeys: ["q1", "folder"] }) : null },
    uc: { url: "https://drive.uc.cn/list/all", query: selector => selector === ".file-list"
      ? reactSelection({ list: [{ fid: "u1", file_name: name, size: 42, file: true }], selectedRowKeys: ["u1"] }) : null },
    "123pan": { url: "https://www.123pan.com/", storage: { authorToken: "PAN123_TOKEN", LoginUuid: "login-uuid" },
      query: selector => selector.startsWith(".ant-table-wrapper") ? reactSelection({ dataSource: [
        { FileId: 123, FileName: name, Size: 42, Type: 0, Etag: "file-etag", S3KeyFlag: "s3-key" },
        { FileId: 124, FileName: "unselected", Size: 42, Type: 0 },
      ], rowSelection: { selectedRowKeys: [123] } }) : null },
  };
  return { ...fixtures[provider], name };
}

function cloudReply(provider, details) {
  const url = new URL(details.url);
  const data = details.data ? JSON.parse(details.data) : null;
  if (provider === "baidu") {
    // 选中的文件夹按 LinkSwift 展开；夹具中的文件夹是空的。
    if (url.searchParams.get("method") === "list") return jsonReply(details, { errno: 0, list: [] });
    assert.deepEqual(JSON.parse(url.searchParams.get("fsids")), [101]);
    assert.equal(url.searchParams.get("access_token"), "BAIDU_TOKEN");
    return jsonReply(details, { errno: 0, list: [{ fs_id: 101, dlink: "https://d.pcs.baidu.com/download/file" }] });
  }
  if (provider === "aliyun") {
    assert.deepEqual(data, { drive_id: "drive1", file_id: "a1" });
    assert.equal(details.headers.Authorization, "Bearer ALI_TOKEN");
    return jsonReply(details, { url: "https://files.example/ali.bin" });
  }
  if (provider === "mcloud") {
    assert.deepEqual(data, { fileId: "m1" });
    assert.equal(details.headers.Authorization, "Bearer MOBILE_TOKEN");
    const [time, nonce, sign] = details.headers["Mcloud-Sign"].split(",");
    assert.equal(nonce.length, 16, "the upstream undefined-prefix nonce bug is fixed");
    const sorted = encodeURIComponent(JSON.stringify(data).replace(/\s*/g, "")).split("").sort().join("");
    assert.equal(sign, md5(md5(btoa(sorted)) + md5(`${time}:${nonce}`)).toUpperCase());
    return jsonReply(details, { success: true, data: { url: "https://files.example/mobile.bin" } });
  }
  if (provider === "tcloud") {
    if (url.pathname.endsWith("ssoH5.action")) return details.onload({ status: 200, finalUrl: "https://cloud.189.cn/web/main?accessToken=TELECOM_TOKEN" });
    assert.equal(url.searchParams.get("fileId"), "t1");
    assert.equal(details.headers.Signature, md5(`AccessToken=TELECOM_TOKEN&Timestamp=${details.headers.Timestamp}&fileId=t1`));
    return jsonReply(details, { res_code: 0, fileDownloadUrl: "https://files.example/telecom.bin" });
  }
  if (provider === "xunlei") {
    assert.equal(details.headers.Authorization, "Bearer SOURCE_TOKEN");
    assert.equal(details.headers["X-Captcha-Token"], "SOURCE_CAPTCHA");
    return jsonReply(details, { web_content_link: "https://files.example/xunlei.bin" });
  }
  if (provider === "guangya") {
    assert.deepEqual(data, { fileId: "g1" });
    assert.equal(details.headers["X-Captcha-Token"], "SOURCE_CAPTCHA");
    return jsonReply(details, { code: 0, data: { signedURL: "https://files.example/guangya.bin" } });
  }
  if (provider === "quark" || provider === "uc") {
    if (url.hostname === "drive-social-api.quark.cn") return jsonReply(details, { code: 0, data: { token: "SOCIAL_TOKEN" } });
    assert.deepEqual(data.fids, [provider === "quark" ? "q1" : "u1"]);
    if (provider === "quark") assert.equal(data.token, "SOCIAL_TOKEN");
    return jsonReply(details, { code: 0, data: [{ fid: data.fids[0], download_url: `https://dl.${provider === "quark" ? "quark.cn" : "uc.cn"}/file.bin` }] });
  }
  assert.equal(provider, "123pan");
  assert.equal(data.fileId, 123);
  assert.equal(data.s3keyFlag, "s3-key");
  assert.equal(details.headers.Authorization, "Bearer PAN123_TOKEN");
  assert.equal(details.headers.LoginUuid, "login-uuid");
  return jsonReply(details, { code: 0, data: { dispatchList: [{ prefix: "https://files.example" }], downloadPath: "/123.bin" } });
}

for (const manager of ["sync", "async"]) for (const isolated of [false, true]) for (const provider of ["baidu", "aliyun", "mcloud", "tcloud", "xunlei", "guangya", "quark", "uc", "123pan"]) {
  test(`cloud ${provider}: selected file to parse ticket and task, with isolated credentials (${manager}, ${isolated ? "content realm" : "page access"})`, async () => {
    const fixture = cloudFixture(provider);
    const h = harness({ ...fixture, manager, isolated, bridge: isolated && manager === "sync" ? "privileged" : "dom", gm: details => {
      if (new URL(details.url).hostname !== "tessera.example") {
        assert.ok(!JSON.stringify(details).includes("TEST:secret"), "the Tessera credential never reaches a provider");
        // 与 LinkSwift 一致：百度自盘、夸克、UC、123 以客户端身份取链，其余网盘保持浏览器身份。
        const identity = { baidu: "pan.baidu.com", quark: "QuarkPC/", uc: "uc-cloud-drive/", "123pan": "123pan/" }[provider];
        const agent = details.headers["User-Agent"];
        if (identity) assert.ok(agent?.includes(identity), `${provider} uses the LinkSwift client User-Agent`);
        else assert.equal(agent, undefined, `${provider} keeps the browser User-Agent`);
        assert.equal(details.headers.Origin, new URL(fixture.url).origin);
        assert.equal(details.headers.Referer, new URL(fixture.url).origin + "/");
        return cloudReply(provider, details);
      }
      if (details.url.endsWith("/parse")) {
        const body = JSON.parse(details.data);
        assert.equal(body.download_type, "http");
        assert.ok(!body.input.includes("tessera-"), "submit the resolved download URL, not the synthetic selection identity");
        assert.ok(body.input.includes("-o '来自 "), "pass the cloud filename even when the CDN has no filename");
        if (provider === "baidu") assert.ok(body.input.includes("User-Agent: pan.baidu.com"));
        if (provider === "quark") assert.ok(body.input.includes("Cookie: __pugs=SOURCE_COOKIE"));
        if (provider === "aliyun") assert.ok(!body.input.includes("ALI_TOKEN"), "API OAuth token is not a download header");
        return jsonReply(details, { candidates: [{ ticket: "sealed-ticket", name: "cdn.bin", kind: "http", size: 42 }] });
      }
      const body = JSON.parse(details.data);
      assert.deepEqual(body, { items: [{ ticket: "sealed-ticket", name: fixture.name }], destination: "photos/" });
      return jsonReply(details, { tasks: [{ id: 21, status: "queued", key: "photos/file.bin" }] });
    } });
    await h.ready;
    h.api.gm.set("cloud-baidu-token", { token: "BAIDU_TOKEN", expires: Date.now() + 3600000 });
    const sources = await h.api.cloudSources(h.api.cloudOf());
    assert.equal(sources.length, 1, "ignore folders and unselected files");
    assert.equal(sources[0].name, fixture.name);
    const current = h.batch(sources.map(item => ({ ...item, sourceName: item.name, type: "file", state: "parsing", tasks: [], error: "" })));
    current.mode = "server";
    await h.api.parseEntries(current, current.entries.slice());
    assert.equal(current.entries[0].state, "waiting", current.entries[0].error);
    assert.equal(current.entries[0].name, fixture.name);
    assert.equal(current.entries[0].cloud.provider, provider);
    await h.api.runBatch();
    assert.equal(current.entries[0].state, "submitted");
    assert.equal(h.fetches.length, 0, "the browser never downloads file bytes in server mode");
    assert.ok(h.values.sent.includes(sources[0].url));
    assert.equal(h.injected.length, isolated ? 1 : 0);
    assert.ok(h.scriptNodes.every(node => node.removed), "remove the page reader and its metadata after each click");
    assert.ok(h.injected.every(code => !/TEST:secret|SOURCE_TOKEN|ALI_TOKEN/.test(code)), "never pass credentials into page code");
    assert.equal(vm.runInContext("typeof GM", h.pageContext), "undefined", "the page realm has no privileged API");
  });
}

test("cloud provider detection uses exact HTTPS hosts and recognizes nested share routes", () => {
  const h = harness();
  for (const url of ["https://pan.baidu.com.evil.example/disk/main", "http://pan.quark.cn/list/all", "https://api.alipan.com/", "https://123pan.com.evil.example/", "https://user:secret@pan.baidu.com/disk/main"]) assert.equal(h.api.cloudOf(url), null);
  assert.equal(h.api.cloudOf("https://cloud.189.cn/web/share?code=a").share, true);
  assert.equal(h.api.cloudOf("https://www.123865.com/s/abc").provider, "123pan");
});

test("cloud MD5 signatures match independent UTF-8 and multi-block vectors", () => {
  const h = harness();
  for (const input of ["", "abc", "中文签名😀", "a".repeat(55), "b".repeat(56), "c".repeat(64), "d".repeat(1000)]) assert.equal(h.api.cloudMd5(input), md5(input));
});

test("cloud curl preserves signed URLs and shell-quotes names without duplicating headers", async () => {
  const h = harness();
  const curl = await h.api.curlFor("https://dl.quark.cn/file?sign=a&b=2", true, { "User-Agent": "QuarkPC/1", Cookie: "__pugs=one'two" }, "原'文件.bin");
  assert.equal((curl.match(/User-Agent:/g) || []).length, 1);
  assert.ok(curl.includes("'User-Agent: QuarkPC/1'"));
  assert.ok(curl.includes("__pugs=one'\\''two"));
  assert.ok(curl.includes("-o '原'\\''文件.bin'"));
  assert.ok(!(await h.api.curlFor("https://dl.quark.cn/file", false, { Cookie: "secret" })).includes("Cookie:"));
  await assert.rejects(() => h.api.curlFor("https://files.example/a", true, { Referer: "x\r\nAuthorization: secret" }), /请求头无效/);
});

test("cloud selection snapshots are immutable and enforce the batch limit before requests", async () => {
  const fixture = cloudFixture("aliyun");
  const item = Object.freeze({ fileId: "a1", driveId: "drive1", name: "a.bin", size: 42, type: "file" });
  let files = [item];
  const h = harness({ ...fixture, query: () => reactSelection({ dataSource: files, selectedKeys: files.map(file => file.fileId) }) });
  const sources = await h.api.cloudSources(h.api.cloudOf());
  sources[0].cloud.file.name = "changed";
  assert.equal(item.name, "a.bin");
  files = Array.from({ length: 1000 }, (_, index) => ({ ...item, fileId: String(index) }));
  assert.equal((await h.api.cloudSources(h.api.cloudOf())).length, 1000, "LinkSwift does not stop at 50 files");
  files = Array.from({ length: 1001 }, (_, index) => ({ ...item, fileId: String(index) }));
  await assert.rejects(() => h.api.cloudSources(h.api.cloudOf()), /最多发送 1000/);
  assert.equal(h.requests.length, 0);
});

function quarkHarness(files, reply) {
  return harness({ url: "https://pan.quark.cn/list/all", documentCookie: "__pugs=C", gmCookies: [{ name: "__pugs", value: "C" }],
    query: selector => selector === ".file-list" ? reactSelection({ list: files, selectedRowKeys: files.map(file => file.fid) }) : null,
    gm: details => {
      const url = new URL(details.url);
      if (url.hostname === "drive-social-api.quark.cn") return jsonReply(details, { code: 0, data: { token: "T" } });
      if (url.hostname === "drive-pc.quark.cn") return reply(details, JSON.parse(details.data));
      if (details.url.endsWith("/parse")) return jsonReply(details, { candidates: [{ ticket: "t", name: "x.bin", kind: "http", size: 1 }] });
      throw new Error(`unexpected request ${details.url}`);
    } });
}
async function parseCloudSelection(h) {
  await h.ready;
  const sources = await h.api.cloudSources(h.api.cloudOf());
  const current = h.batch(sources.map(item => ({ ...item, sourceName: item.name, type: "file", state: "parsing", tasks: [], error: "" })));
  current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  return current;
}

test("cloud quark fetches links 15 files per request as the PC client, pausing between batches like LinkSwift", async () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ fid: `q${index}`, file_name: `f${index}.bin`, size: 1, file: true }));
  const calls = [];
  const h = quarkHarness(files, (details, body) => {
    calls.push({ fids: body.fids, at: Date.now(), agent: details.headers["User-Agent"] });
    return jsonReply(details, { code: 0, data: body.fids.map(fid => ({ fid, download_url: `https://dl.quark.cn/${fid}` })) });
  });
  const current = await parseCloudSelection(h);
  assert.deepEqual(calls.map(call => call.fids.length), [15, 5]);
  assert.ok(calls[1].at - calls[0].at >= 900, "rest about a second between batches");
  assert.ok(calls.every(call => call.agent.includes("QuarkPC/")));
  assert.ok(current.entries.every(entry => entry.state === "waiting"), current.entries.map(entry => entry.error).join());
});

test("cloud provider errors keep the provider's code and message, and a failed batch retries file by file", async () => {
  const big = "b".repeat(32), small = "a".repeat(32);
  const files = [{ fid: small, file_name: "small.bin", size: 1, file: true }, { fid: big, file_name: "movie.mkv", size: 9e9, file: true }];
  const calls = [];
  const h = quarkHarness(files, (details, body) => {
    calls.push(body.fids);
    if (body.fids.includes(big)) return details.onload({ status: 400, responseText: JSON.stringify({ status: 400, code: 23018, message: `file [${big}] size limit` }) });
    return jsonReply(details, { code: 0, data: [{ fid: small, download_url: "https://dl.quark.cn/small" }] });
  });
  const current = await parseCloudSelection(h);
  assert.deepEqual(calls, [[small, big], [small], [big]]);
  const [ok, failed] = current.entries;
  assert.equal(ok.state, "waiting");
  assert.equal(failed.state, "parse-error");
  assert.match(failed.error, /超出夸克网盘游客可获取的文件大小.*movie\.mkv/);
  const generic = quarkHarness([files[0]], details => details.onload({ status: 400, responseText: JSON.stringify({ code: 41008, message: "签名\n已过期" }) }));
  const [entry] = (await parseCloudSelection(generic)).entries;
  assert.match(entry.error, /（代码 41008），服务器说：签名 已过期/);
});

test("cloud baidu expands selected folders in my drive with the pan.baidu.com identity", async () => {
  const listed = [];
  const h = harness({ url: "https://pan.baidu.com/disk/main", query: selector => selector === ".wp-s-core-pan" ? { __vue__: { selectedList: [
    { fs_id: 1, server_filename: "top.bin", size: 1, isdir: 0 }, { fs_id: 2, server_filename: "album", isdir: 1, path: "/album" }] } } : null,
  gm: details => {
    const url = new URL(details.url);
    assert.equal(details.headers["User-Agent"], "pan.baidu.com");
    listed.push(url.searchParams.get("dir"));
    if (url.searchParams.get("dir") === "/album") return jsonReply(details, { errno: 0, list: [
      { fs_id: 3, server_filename: "a.jpg", size: 2, isdir: 0 }, { fs_id: 4, server_filename: "sub", isdir: 1, path: "/album/sub" }] });
    return jsonReply(details, { errno: 0, list: [{ fs_id: 5, server_filename: "b.jpg", size: 3, isdir: 0 }] });
  } });
  await h.ready;
  await assert.rejects(() => h.api.cloudSources(h.api.cloudOf()), /授权百度取链/);
  h.api.gm.set("cloud-baidu-token", { token: "BAIDU_TOKEN", expires: Date.now() + 3600000 });
  const sources = await h.api.cloudSources(h.api.cloudOf());
  assert.deepEqual(Array.from(sources, item => item.name), ["top.bin", "a.jpg", "b.jpg"]);
  assert.deepEqual(listed, ["/album", "/album/sub"]);
});

test("cloud share modes missing an upstream resolver explain the save-to-own-drive workflow", async () => {
  const h = harness();
  for (const url of ["https://www.alipan.com/s/share", "https://pan.xunlei.com/s/share", "https://yun.139.com/link/share"]) await assert.rejects(() => h.api.cloudSources(h.api.cloudOf(url)), /保存到自己的网盘/);
  const guide = h.api.cloudShareGuide(h.api.cloudOf("https://www.alipan.com/s/share/folder/file"));
  assert.equal(guide.url, "https://www.alipan.com/drive/file/all");
  assert.match(guide.hint, /转存成功后留在分享页仍无法发送/);
  assert.equal(h.api.cloudShareGuide(h.api.cloudOf("https://pan.quark.cn/s/share")), null);
  assert.equal(h.api.cloudShareGuide(h.api.cloudOf("https://www.alipan.com/drive/file/all")), null);
  assert.equal(h.requests.length, 0);
});

for (const manager of ["sync", "async"]) test(`cloud Quark share reads class state, ignores stale empty lists and refreshes each click (${manager})`, async () => {
  const files = [{ fid: "selected", file_name: "已选文件.bin", file: true, share_fid_token: "FILE_TOKEN", access_token: "ACCOUNT_SECRET" },
    { fid: "other", file_name: "没有勾选.bin", file: true, checked: true }];
  const state = { selectedRowKeys: ["selected"] };
  const current = { __reactFiber$fixture: { return: { stateNode: { props: { list: files, stoken: "STOKEN" }, state } } } };
  const h = harness({ manager, isolated: true, url: "https://pan.quark.cn/s/share-id", dom: selector => selector === ".file-list"
    ? [reactSelection({ list: [], selectedRowKeys: [] }), current] : [] });
  await h.ready;
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  assert.equal(source.name, "已选文件.bin");
  assert.equal(source.cloud.file.stoken, "STOKEN");
  assert.equal(source.cloud.file.share_fid_token, "FILE_TOKEN");
  assert.ok(!JSON.stringify(source).includes("ACCOUNT_SECRET"));
  assert.ok(h.injected.every(code => !code.includes("STOKEN") && !code.includes("已选文件")));
  state.selectedRowKeys = [];
  await assert.rejects(() => h.api.cloudSources(h.api.cloudOf()), /请先在网盘中勾选文件/);
  assert.equal(h.injected.length, 2, "do not cache selection between clicks");
  assert.ok(h.scriptNodes.every(node => node.removed));
  assert.equal(h.requests.length, 0);
});

test("cloud Aliyun grid reads selection from class state with Set keys", async () => {
  const h = harness({ manager: "async", isolated: true, url: "https://www.alipan.com/drive/file/all", query: selector => selector.includes("node-list-grid-view")
    ? { __reactFiber$fixture: { stateNode: { props: { dataSource: [{ fileId: "a1", driveId: "drive", name: "网格.bin", type: "file" }] }, state: { selectedKeys: new Set(["a1"]) } } } } : null });
  await h.ready;
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  assert.equal(source.name, "网格.bin");
  assert.equal(source.cloud.file.fileId, "a1");
});

for (const bridge of ["blocked", "trusted-types"]) test(`cloud blocked page reader reports access failure without asking for selection (${bridge})`, async () => {
  const h = harness({ ...cloudFixture("quark"), isolated: true, bridge });
  await assert.rejects(() => h.api.cloudSources(h.api.cloudOf()), error => {
    assert.match(error.message, /无法读取.*勾选状态/);
    assert.ok(!error.message.includes("请先在网盘中勾选文件"));
    return true;
  });
  assert.equal(h.requests.length, 0);
  assert.ok(h.scriptNodes.every(node => node.removed));
});

test("cloud unknown page layout is distinct from an empty selection", async () => {
  const h = harness({ url: "https://pan.quark.cn/s/share-id", isolated: true });
  await assert.rejects(() => h.api.cloudSources(h.api.cloudOf()), /暂未识别到网盘文件列表/);
  assert.equal(h.requests.length, 0);
});

test("cloud late page-reader response cannot use selection after navigation", async () => {
  let reply;
  const h = harness({ ...cloudFixture("quark"), isolated: true });
  h.api.gm.pageScript = () => new Promise(resolve => { reply = resolve; });
  const pending = h.api.cloudSources(h.api.cloudOf());
  h.context.location = new URL("https://pan.quark.cn/s/new-share");
  let removed = false;
  reply({ getAttribute: () => JSON.stringify({ available: true, files: [{ fid: "old-file", file_name: "old.bin", file: true }] }), remove() { removed = true; } });
  await assert.rejects(() => pending, /页面已切换/);
  assert.equal(removed, true);
  assert.equal(h.requests.length, 0);
});

test("cloud request rejects a different provider, arbitrary API hosts and foreign cookie download targets", async () => {
  const h = harness(cloudFixture("aliyun"));
  const context = (await h.api.cloudSources(h.api.cloudOf()))[0].cloud;
  await assert.rejects(() => h.api.cloudRequest(context, "https://evil.example/api"), /接口地址无效/);
  await assert.rejects(() => h.api.cloudRequest(context, "https://api.alipan.com/v2/file/get_download_url", { headers: { Host: "evil.example" } }), /请求头无效/);
  assert.throws(() => h.api.cloudDownload(context, "https://evil.example/file", { Cookie: "source-secret" }), /未转交登录 Cookie/);
  assert.throws(() => h.api.cloudDownload({ provider: "quark" }, "https://dl.uc.cn/file", { cookie: "source-secret" }), /未转交登录 Cookie/);
  h.context.location = new URL("https://pan.quark.cn/list/all");
  await assert.rejects(() => h.api.resolveCloud(context), /返回原网盘页面/);
  assert.equal(h.requests.length, 0);
});

for (const manager of ["sync", "async"]) test(`cloud Baidu authorization requires matching state, expiry and the provider origin (${manager})`, async () => {
  let cleaned = "";
  const h = harness({ manager, url: "https://pan.baidu.com/disk/main", pageState: { history: { replaceState: (_, __, url) => { cleaned = url; } } } });
  await h.ready;
  h.api.authorizeCloudBaidu();
  await tick();
  const authorize = new URL(h.opened[0]);
  assert.equal(authorize.hostname, "openapi.baidu.com");
  const state = authorize.searchParams.get("state");
  assert.equal(state.length, 32);
  const callback = `https://openapi.baidu.com/oauth/2.0/login_success#access_token=OAUTH_TOKEN&expires_in=3600&state=${state}`;
  h.context.location = new URL(callback.replace(state, "wrong"));
  assert.equal(h.api.captureCloudAuthorization(), false);
  h.context.location = new URL(callback.replace("openapi.baidu.com", "evil.example"));
  assert.equal(h.api.captureCloudAuthorization(), false);
  h.context.location = new URL(callback);
  assert.equal(h.api.captureCloudAuthorization(), true);
  await tick();
  assert.equal(h.values["cloud-baidu-token"].token, "OAUTH_TOKEN");
  assert.equal(cleaned, "/oauth/2.0/login_success", "remove the token fragment after capture");
  assert.equal(h.api.captureCloudAuthorization(), false, "state is single use");
  h.api.gm.set("cloud-baidu-auth", { state, expires: Date.now() - 1 });
  assert.equal(h.api.captureCloudAuthorization(), false, "expired authorization cannot overwrite a token");
});

for (const manager of ["sync", "async"]) test(`cloud Quark share reads isolated selection and rotates __pugs (${manager})`, async () => {
  const h = harness({ isolated: true, manager, url: "https://pan.quark.cn/s/share123", cookieApi: false, documentCookie: "__pugs=old; login=private", query: () => reactSelection({
    list: [{ fid: "q-share", file_name: "share.bin", file: true, share_fid_token: "FILE_SHARE_TOKEN" }], selectedRowKeys: ["q-share"], stoken: "SHARE_TOKEN",
  }), gm: details => {
    if (details.url.includes("drive-social-api")) return jsonReply(details, { code: 0, data: { token: "SOCIAL" } });
    assert.deepEqual(JSON.parse(details.data), { fids: ["q-share"], speedup_session: "", token: "SOCIAL", pwd_id: "share123", stoken: "SHARE_TOKEN", fids_token: ["FILE_SHARE_TOKEN"] });
    return jsonReply(details, { code: 0, data: [{ fid: "q-share", download_url: "https://dl.quark.cn/share.bin" }] }, { responseHeaders: "Set-Cookie: __pugs=new-cookie; Path=/; Secure\r\n" });
  } });
  await h.ready;
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const result = await h.api.resolveCloud(source.cloud);
  assert.equal(result.headers.Cookie, "__pugs=new-cookie");
  assert.ok(!JSON.stringify(result).includes("SHARE_TOKEN"));
});

test("cloud disabled cookie forwarding fails Quark before requesting a download", async () => {
  const h = harness({ ...cloudFixture("quark"), cookies: false });
  const context = (await h.api.cloudSources(h.api.cloudOf()))[0].cloud;
  await assert.rejects(() => h.api.resolveCloud(context), /启用携带 Cookie/);
  assert.equal(h.requests.length, 0);
});

test("cloud HTML challenge stays a parse failure and never creates a task", async () => {
  const h = harness({ ...cloudFixture("aliyun"), gm: details => details.onload({ status: 403, responseHeaders: "server: cloudflare\r\ncf-mitigated: challenge", responseText: "Just a moment" }) });
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const current = h.batch([{ ...source, sourceName: source.name, state: "parsing", tasks: [] }]); current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  assert.equal(current.entries[0].state, "parse-error");
  assert.equal(current.entries[0].challenge, true);
  assert.match(current.entries[0].error, /人机验证/);
  assert.ok(h.requests.every(request => new URL(request.details.url).hostname !== "tessera.example"));
  assert.equal(h.values.sent, undefined);
});

test("cloud retry acquires a new signed URL and ticket while preserving the edited filename", async () => {
  let signed = 0;
  const h = harness({ ...cloudFixture("aliyun"), gm: details => {
    if (details.url.includes("api.alipan.com")) return jsonReply(details, { url: `https://files.example/file?sign=${++signed}` });
    if (details.url.endsWith("/parse")) return jsonReply(details, { candidates: [{ ticket: `ticket-${signed}`, name: "cdn.bin", kind: "http" }] });
    return jsonReply(details, { tasks: [{ id: signed, status: "queued" }] });
  } });
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const current = h.batch([{ ...source, sourceName: source.name, state: "parsing", tasks: [] }]); current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  await h.api.runBatch();
  const old = current.entries[0];
  old.tasks[0].status = "failed";
  old.name = "修改后的文件.bin"; old.nameEdited = true;
  await h.api.retryEntries([old]);
  await until(() => current.entries[0].state === "submitted");
  assert.equal(signed, 2);
  const creates = h.requests.filter(request => new URL(request.details.url).pathname === "/api/v1/downloads");
  assert.deepEqual(JSON.parse(creates[1].details.data).items, [{ ticket: "ticket-2", name: "修改后的文件.bin" }]);
});

test("cloud 123 wrapped dispatch links are decoded and quota errors remain actionable", async () => {
  let quota = false;
  const h = harness({ ...cloudFixture("123pan"), gm: details => jsonReply(details, quota ? { code: 5113 } : { code: 0, data: {
    dispatchList: [{ prefix: "https://files.example" }], downloadPath: "/wrapper?params=" + encodeURIComponent(btoa("https://files.example/actual?sign=1")),
  } }) });
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  assert.equal((await h.api.resolveCloud(source.cloud)).url, "https://files.example/actual?sign=1");
  quota = true;
  await assert.rejects(() => h.api.resolveCloud(source.cloud), /下载流量不足/);
});

test("cloud Baidu share reads isolated page verification without exposing GM APIs", async () => {
  const h = harness({ isolated: true, url: "https://pan.baidu.com/s/1share?pwd=1234", query: selector => selector === ".wp-s-core-pan"
    ? { __vue__: { selectedList: [{ fs_id: 9, server_filename: "shared.bin", isdir: 0 }] } } : null,
    pageState: { locals: { dump: () => ({ share_uk: { value: "uk" }, shareid: { value: "share-id" }, bdstoken: { value: "BDSTOKEN" } }) }, jsToken: "JS_TOKEN", currentSekey: "SHARE_KEY" },
    gm: details => {
      if (details.url.includes("tplconfig")) return jsonReply(details, { data: { sign: "sign", timestamp: 123 } });
      const url = new URL(details.url);
      assert.equal(url.searchParams.get("sign"), "sign");
      assert.equal(url.searchParams.get("jsToken"), "JS_TOKEN");
      const form = new URLSearchParams(details.data);
      assert.equal(form.get("uk"), "uk");
      assert.equal(form.get("fid_list"), "[9]");
      assert.deepEqual(JSON.parse(form.get("extra")), { sekey: "SHARE_KEY" });
      return jsonReply(details, { errno: 0, list: [{ fs_id: 9, dlink: "https://d.pcs.baidu.com/shared.bin" }] });
    },
  });
  const result = await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud);
  assert.equal(result.url, "https://d.pcs.baidu.com/shared.bin");
  assert.ok(!result.url.includes("pwd="));
  assert.equal(h.opened.length, 0);
});

test("cloud Tianyi share signature includes the share identity in the prescribed order", async () => {
  const h = harness({ url: "https://cloud.189.cn/web/share?code=abc", query: selector => selector === ".info-detail"
    ? { __vue__: { fileDetail: { fileId: "t1", fileName: "shared.bin", isFolder: false, shareId: "s1" } } } : null,
    gm: details => {
      if (details.url.includes("ssoH5.action")) return details.onload({ status: 200, finalUrl: "https://cloud.189.cn/web/main?accessToken=TOKEN" });
      assert.equal(new URL(details.url).searchParams.get("shareId"), "s1");
      assert.equal(details.headers.Signature, md5(`AccessToken=TOKEN&Timestamp=${details.headers.Timestamp}&dt=1&fileId=t1&shareId=s1`));
      return jsonReply(details, { res_code: 0, fileDownloadUrl: "https://files.example/share.bin" });
    },
  });
  assert.equal((await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud)).url, "https://files.example/share.bin");
});

test("cloud Guangya share sends the user-entered code to the provider and keeps its access token off the download request", async () => {
  const fixture = cloudFixture("guangya");
  const h = harness({ ...fixture, url: "https://www.guangyapan.com/s/share-id?code=1234", gm: details => {
    const body = JSON.parse(details.data);
    if (details.url.includes("get_share_access_token")) {
      assert.deepEqual(body, { shareId: "share-id", code: "1234" });
      return jsonReply(details, { data: { accessToken: "SHARE_ACCESS" } });
    }
    assert.deepEqual(body, { fileId: "g1", accessToken: "SHARE_ACCESS" });
    return jsonReply(details, { data: { downloadUrl: "https://files.example/share.bin" } });
  } });
  const result = await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud);
  assert.ok(!JSON.stringify(result).includes("SHARE_ACCESS"));
});

test("cloud UC share preserves file and share tokens but exports only its download headers", async () => {
  const h = harness({ manager: "async", isolated: true, url: "https://drive.uc.cn/s/share-id", query: () => reactSelection({
    list: [{ fid: "u-share", file_name: "shared.bin", file: true, share_fid_token: "FILE_TOKEN" }], selectedRowKeys: ["u-share"], stoken: "STOKEN",
  }), gm: details => {
    assert.deepEqual(JSON.parse(details.data), { fids: ["u-share"], pwd_id: "share-id", stoken: "STOKEN", fids_token: ["FILE_TOKEN"] });
    return jsonReply(details, { code: 0, data: [{ fid: "u-share", download_url: "https://dl.uc.cn/shared.bin" }] });
  } });
  await h.ready;
  const result = await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud);
  assert.ok(result.headers["User-Agent"].includes("uc-cloud-drive"));
  assert.ok(!JSON.stringify(result).includes("STOKEN"));
});

test("cloud 123 single-file share selection uses the share API without requiring a login token", async () => {
  const h = harness({ url: "https://www.123pan.com/s/share-key", query: () => reactSelection({ file: { FileId: 12, FileName: "shared.bin", Size: 42, Type: 0, Etag: "etag", S3KeyFlag: "s3" } }),
    gm: details => {
      assert.equal(new URL(details.url).pathname, "/api/v2/share/download/info");
      assert.deepEqual(JSON.parse(details.data), { ShareKey: "share-key", FileID: 12, S3keyFlag: "s3", Size: 42, Etag: "etag" });
      assert.equal(details.headers.Authorization, undefined);
      return jsonReply(details, { data: { dispatchList: [{ prefix: "https://files.example" }], downloadPath: "/shared.bin" } });
    },
  });
  assert.equal((await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud)).url, "https://files.example/shared.bin");
});

test("cloud Xunlei renews expired tokens once and signs the provider captcha request", async () => {
  const fixture = cloudFixture("xunlei");
  fixture.storage.credentials_client.expires_at = "2000-01-01";
  fixture.storage.credentials_client.refresh_token = "REFRESH_SECRET";
  fixture.storage.captcha_client.expires_at = "2000-01-01";
  const calls = [];
  const h = harness({ ...fixture, gm: details => {
    const url = new URL(details.url); calls.push(url.pathname);
    if (url.pathname === "/v1/auth/token") {
      assert.equal(JSON.parse(details.data).refresh_token, "REFRESH_SECRET");
      return jsonReply(details, { access_token: "NEW_ACCESS", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/v1/shield/captcha/init") {
      const body = JSON.parse(details.data);
      assert.match(body.meta.captcha_sign, /^1\.[a-f0-9]{32}$/);
      assert.equal(body.device_id, "0123456789abcdef0123456789abcdef");
      return jsonReply(details, { captcha_token: "NEW_CAPTCHA", expires_in: 3600 });
    }
    assert.equal(details.headers.Authorization, "Bearer NEW_ACCESS");
    assert.equal(details.headers["X-Captcha-Token"], "NEW_CAPTCHA");
    return jsonReply(details, { web_content_link: "https://files.example/file.bin" });
  } });
  const result = await h.api.resolveCloud((await h.api.cloudSources(h.api.cloudOf()))[0].cloud);
  assert.equal(calls.join(","), "/v1/auth/token,/v1/shield/captcha/init,/drive/v1/files/x1");
  assert.ok(!JSON.stringify(result).includes("REFRESH_SECRET"));
});

test("cloud private-space handoff carries renamed tickets, with no key-API private task creation", async () => {
  const h = harness({ ...cloudFixture("aliyun"), manager: "async", gm: details => details.url.includes("api.alipan.com")
    ? jsonReply(details, { url: "https://files.example/private.bin" }) : jsonReply(details, { candidates: [{ ticket: "private-ticket", name: "cdn.bin", kind: "http" }] }) });
  await h.ready;
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const current = h.batch([{ ...source, sourceName: source.name, state: "parsing", tasks: [] }]);
  current.mode = "server"; current.destination.private = true;
  await h.api.parseEntries(current, current.entries.slice());
  current.entries[0].name = "私密文件.bin";
  await h.api.runBatch();
  const imported = JSON.parse(Buffer.from(new URL(h.opened[0]).hash.slice("#import=".length), "base64url"));
  assert.equal(imported.private, true);
  assert.equal(imported.candidates[0].name, "私密文件.bin");
  assert.equal(imported.candidates[0].ticket, "private-ticket");
  assert.ok(!JSON.stringify(imported).includes("ALI_TOKEN"));
  assert.ok(!h.requests.some(request => new URL(request.details.url).pathname === "/api/v1/downloads"));
});

test("cloud retry after an expired SSO session obtains fresh credentials before parsing", async () => {
  let tokens = 0;
  const h = harness({ ...cloudFixture("tcloud"), gm: details => {
    if (details.url.includes("ssoH5.action")) return details.onload({ status: 200, finalUrl: `https://cloud.189.cn/web/main?accessToken=TOKEN${++tokens}` });
    if (details.url.includes("getFileDownloadUrl.action")) return jsonReply(details, tokens === 1
      ? { errorcode: "InvalidSessionKey" } : { res_code: 0, fileDownloadUrl: "https://files.example/fresh.bin" });
    return jsonReply(details, { candidates: [{ ticket: "fresh-ticket", name: "fresh.bin", kind: "http" }] });
  } });
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const current = h.batch([{ ...source, sourceName: source.name, state: "parsing", tasks: [] }]); current.mode = "server";
  await h.api.parseEntries(current, current.entries.slice());
  assert.equal(current.entries[0].state, "parse-error");
  await h.api.parseEntries(current, current.entries.slice());
  assert.equal(tokens, 2);
  assert.equal(current.entries[0].candidate.ticket, "fresh-ticket");
});

test("cloud late resolution cannot recreate a removed row or submit its URL to Tessera", async () => {
  let reply;
  const h = harness({ ...cloudFixture("aliyun"), gm: details => { reply = details; } });
  const source = (await h.api.cloudSources(h.api.cloudOf()))[0];
  const current = h.batch([{ ...source, sourceName: source.name, state: "parsing", tasks: [] }]); current.mode = "server";
  const pending = h.api.parseEntries(current, current.entries.slice());
  await until(() => Boolean(reply));
  current.entries = [];
  jsonReply(reply, { url: "https://files.example/late.bin" });
  await pending;
  assert.equal(current.entries.length, 0);
  assert.equal(h.requests.length, 1);
});
