// Run with: node --test tests/test_grabber.cjs
// Execute the real single-file userscript, stubbing only browser/GM boundaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../userscripts/tessera-grabber.user.js"), "utf8");
const instrumented = source.replace(/\s+applySiteState\(\);\s*\}\)\(\);\s*$/, `
  globalThis.toastMessages = [];
  toast = message => globalThis.toastMessages.push(message);
  globalThis.grabber = { browserDownload, api, cookieHeader, runBatch, retryEntries, stopBatch, parseEntries, clearEntries, clearBatch, close,
    getBatch: () => batch, setBatch: value => { batch = value; }, BROWSER_MAX_BYTES,
    pageSnapshot, addAssistantPage, assistantPages, sendAssistantPages };
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

function harness({ fetch, gm, move, remove, open, cookies = true, cookieApi = true } = {}) {
  const values = { settings: { server: "https://tessera.example", key: "TEST:secret", cookies } };
  const requests = [], fetches = [], listeners = [], opened = [];
  const window = { addEventListener(type, listener) { if (type === "message") listeners.push(listener); }, removeEventListener() {},
    open: (url, target) => open ? open(url, target, listeners) : null, fetch: async (url, options) => {
    fetches.push({ url, options });
    return fetch ? fetch(url, options) : imageResponse();
  } };
  const context = vm.createContext({
    window, unsafeWindow: window, document: { cookie: "visible=page", querySelectorAll: () => [] },
    location: new URL("https://gallery.example/album"), navigator: { userAgent: "BrowserTest/1" },
    URL, Blob, Response, ReadableStream, AbortController, btoa, DOMException, TextEncoder, Uint8Array, Uint32Array, crypto: webcrypto,
    setTimeout: (fn, delay) => fn.name === "poll" ? 0 : setTimeout(fn, delay), clearTimeout, clearInterval,
    GM_getValue: (key, fallback) => values[key] ?? fallback,
    GM_setValue: (key, value) => { values[key] = value; },
    GM_registerMenuCommand() {},
    GM_openInTab: url => opened.push(url),
    GM_cookie: cookieApi ? { list: (_, callback) => callback([{ name: "cf_clearance", value: "test-cookie", httpOnly: true }], null) } : undefined,
    GM_xmlhttpRequest: details => {
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
    },
  });
  vm.runInContext(instrumented, context);
  const api = context.grabber;
  const entry = (url = "https://images.example/0048.jpg", type = "image") => ({ url, type, state: "waiting", error: "", tasks: [] });
  const batch = (entries = [entry()]) => {
    const result = { mode: "local", started: false, destination: { path: "photos/", private: false }, entries };
    api.setBatch(result);
    return result;
  };
  return { api, values, requests, fetches, opened, messages: context.toastMessages, entry, batch };
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
