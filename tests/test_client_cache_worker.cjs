// 驱动实际 Service Worker 的 fetch/message 事件；只替换持久存储与服务端，流和加密使用原生实现。
// 运行：node --test tests/test_client_cache_worker.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync, transformSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));

const bundled = buildSync({ entryPoints: [path.join(__dirname, "../web/src/cache-store.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" });
const module_ = { exports: {} };
new Function("module", "exports", bundled.outputFiles[0].text)(module_, module_.exports);
const store = module_.exports;
const source = fs.readFileSync(process.env.TESSERA_CACHE_WORKER_SOURCE || path.join(__dirname, "../web/src/sw/cache-worker.ts"), "utf8");
const worker = transformSync(source.replace(/import\s*\{([^}]+)\}\s*from "\.\.\/cache-store";/, (_, names) =>
  `const {${names.split(",").filter(name => !name.trim().startsWith("type ")).join(",")}} = testStore;`), { loader: "ts", target: "es2022" }).code;
const ORIGIN = "https://cache.test";
const SECRET = ".tgdrive/private/secret.bin";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bytes = size => { const data = Buffer.alloc(size); for (let index = 0; index < size; index++) data[index] = index % 251; return data; };

function harness(t, fixtures = { "file.bin": bytes(3 * store.BLOCK + 137), [SECRET]: bytes(65536) }) {
  const entries = new Map(), blocks = new Map(), listeners = new Map(), timers = new Set();
  const files = new Map(Object.entries(fixtures).map(([name, data], index) => [name, { data, etag: `version-${index}`, valid: true }]));
  const state = { clock: 0, authenticated: true, unlocked: true, key: new Uint8Array(32).fill(1), privateKey: new Uint8Array(32).fill(2), keysHook: null, originHook: null, taskHook: null, clients: [] };
  const preferences = { enabled: true, maxMiB: 1024, video: true, private: true, privateMaxMiB: 256 };
  const policy = { enabled: true, private_enabled: true, private_ttl_days: 7 };
  const tasks = new Map();
  const requests = [];
  // 浏览器对媒体元素发出的 no-cors 请求只保留它自己带的 Range；脚本改写的 Range 会被丢掉，服务端返回整个文件。
  const pageRanges = new Map();
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const memory = {
    ...store,
    deviceId: async () => "device-aaaaaaaaaaaaaaaaaaaa",
    readSettings: async () => ({ ...preferences }),
    getEntry: async key => clone(entries.get(key)),
    ensureEntry: async entry => { if (!entries.has(entry.key)) entries.set(entry.key, clone(entry)); return clone(entries.get(entry.key)); },
    getBlock: async (key, index) => clone(blocks.get(`${key}/${index}`)),
    listEntries: async (ns, tier) => [...entries.values()].filter(entry => (!ns || entry.ns === ns) && (!tier || entry.tier === tier)).map(clone),
    deleteEntries: async keys => {
      for (const key of keys) {
        entries.delete(key);
        for (const block of blocks.keys()) if (block.startsWith(key + "/")) blocks.delete(block);
      }
    },
    touchEntry: async (key, accessed) => { if (entries.has(key)) entries.get(key).accessed = accessed; },
    updateEntryInfo: async (key, info, manual) => { if (!entries.has(key)) throw new Error("缓存已被清理"); entries.get(key).info = clone(info); if (manual !== undefined) entries.get(key).manual = manual; },
    setManualFlags: async flags => { for (const [key, manual] of flags) if (entries.has(key)) entries.get(key).manual = manual; },
    evict: async (items, target, keep) => {
      let total = items.reduce((sum, entry) => sum + entry.bytes, 0);
      const victims = [];
      for (const entry of [...items].sort((a, b) => Number(Boolean(a.manual)) - Number(Boolean(b.manual)) || a.accessed - b.accessed)) {
        if (total <= target) break;
        if (keep?.(entry)) continue;
        victims.push(entry.key); total -= entry.bytes;
      }
      await memory.deleteEntries(victims); return victims;
    },
    putBlock: async (key, index, sealed, length) => {
      const entry = entries.get(key);
      if (!entry) return null;
      if (!entry.blocks.includes(index)) { entry.blocks.push(index); entry.blocks.sort((a, b) => a - b); entry.bytes += length; }
      blocks.set(`${key}/${index}`, clone(sealed));
      return clone(entry);
    },
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  async function fetchMock(input, init) {
    const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
    const url = new URL(request.url), route = url.pathname;
    requests.push(request);
    if (!state.authenticated) return json({}, 401);
    if (route === "/api/user/v1/cache/tasks") {
      if (!state.unlocked || request.headers.get("x-csrf-token") !== "csrf" || !policy.enabled || !policy.private_enabled) return json({}, 403);
      const body = await request.json();
      tasks.set(body.id, { paths: body.paths, identity: store.b64u(state.privateKey) });
      await state.taskHook?.();
      return json({ namespace: "user-namespace", bucket_id: 7, key: store.b64u(state.privateKey) }, 201);
    }
    if (route.startsWith("/api/user/v1/cache/tasks/")) {
      const task = tasks.get(request.headers.get("x-tessera-cache-task"));
      if (route.endsWith("/release")) { tasks.delete(request.headers.get("x-tessera-cache-task")); return json({ ok: true }); }
      if (!task || task.identity !== store.b64u(state.privateKey) || !policy.enabled || !policy.private_enabled) return json({}, 403);
      const body = request.method === "POST" ? await request.json() : {};
      const selected = body.path || url.searchParams.get("path") || url.searchParams.get("prefix");
      if (!task.paths.some(path => selected === path || path.endsWith("/") && selected?.startsWith(path))) return json({}, 403);
      if (route.endsWith("/keys")) {
        const file = files.get(body.path);
        return file?.valid && file.etag === body.etag ? json({ key: store.b64u(await store.hmac(state.privateKey, body.etag)) }) : json({}, 400);
      }
      if (route.endsWith("/list")) return json({ objects: [...files].filter(([path]) => path.startsWith(selected))
        .map(([key, file]) => ({ key, etag: file.etag, size: file.data.length, content_type: "application/octet-stream" })), common_prefixes: [], next_cursor: null });
    }
    if (route === "/api/user/v1/cache/session") return json({ namespace: "user-namespace", bucket_id: 7, key: store.b64u(state.key), policy });
    if (route === "/api/user/v1/cache/check") return json({ valid: [...files.values()].filter(file => file.valid).map(file => file.etag) });
    if (route === "/api/user/v1/private/cache/session") return state.unlocked ? json({ namespace: "user-namespace", key: store.b64u(state.privateKey) }) : json({}, 423);
    if (route === "/api/user/v1/private/cache/keys") {
      if (!state.unlocked) return json({}, 423);
      const body = await request.json(), keys = {};
      for (const etag of body.etags) {
        const valid = [...files].some(([name, file]) => name.startsWith(".tgdrive/private/") && file.valid && file.etag === etag);
        keys[etag] = valid ? { id: "server-id", key: store.b64u(await store.hmac(state.privateKey, etag)) } : null;
      }
      return state.keysHook ? await state.keysHook(request, body, keys) : json({ keys });
    }
    if (route.endsWith("/content")) {
      if (route.includes("/private/") && !state.unlocked) return json({}, 423);
      const file = files.get(url.searchParams.get("path"));
      if (!file?.valid) return json({}, 404);
      const custom = await state.originHook?.(request, file);
      if (custom) return custom;
      const headers = { "Content-Type": file.type || "image/png", "Content-Length": String(file.data.length), ETag: `"${file.etag}"` };
      if (request.method === "HEAD" || !file.data.length) return new Response(null, { headers });
      const sent = request.headers.get("range");
      const dropped = request.mode === "no-cors" && sent !== (pageRanges.get(request.url) ?? null);
      const range = dropped ? null : store.parseRange(sent);
      const span = store.resolveRange(range ?? null, file.data.length);
      if (!span) return new Response(null, { status: 416 });
      return new Response(file.data.subarray(span.start, span.end + 1), {
        status: range ? 206 : 200,
        headers: { ...headers, "Content-Length": String(span.end - span.start + 1),
          ...(range ? { "Content-Range": `bytes ${span.start}-${span.end}/${file.data.length}` } : {}) },
      });
    }
    throw new Error(`未定义的测试请求：${route}`);
  }
  const context = vm.createContext({
    testStore: new Proxy(memory, { get: (target, key) => typeof target[key] === "function" ? (...args) => memory[key](...args) : target[key] }),
    fetch: fetchMock, crypto, Request, Response, Headers, ReadableStream, AbortController, DOMException, URL, URLSearchParams, MessageChannel,
    navigator: { userAgent: "Chrome", storage: { estimate: async () => state.quota ? { quota: state.quota, usage: 0 } : {} } },
    Date: class extends Date { static now() { return Date.now() + state.clock; } },
    setTimeout(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay); timers.add(timer); if (delay > 1000) timer.unref(); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    self: { location: { origin: ORIGIN }, addEventListener: (type, callback) => listeners.set(type, callback), clients: { matchAll: async () => state.clients } },
  });
  vm.runInContext(worker, context);
  const h = {
    state, files, entries, blocks, requests, memory, policy, preferences,
    url(name, options = {}) {
      const secret = name.startsWith(".tgdrive/private/");
      const params = new URLSearchParams({ path: name, v: options.version || files.get(name).etag, bucket_id: "7", ...(secret ? { access: options.access || "grant" } : {}) });
      if (options.download) params.set("download", "1");
      return ORIGIN + "/api/user/v1" + (secret ? "/private" : "") + "/content?" + params;
    },
    async request(name, options = {}) {
      let response;
      const request = new Request(h.url(name, options), { headers: options.range ? { Range: options.range } : {}, signal: options.signal, ...(options.media ? { mode: "no-cors" } : {}) });
      if (options.media) pageRanges.set(request.url, options.range ?? null);
      listeners.get("fetch")({ request, respondWith: value => { response = value; } });
      return response ? await response : fetchMock(request);
    },
    async read(name, options) { const response = await h.request(name, options); return { response, data: Buffer.from(await response.arrayBuffer()) }; },
    async message(type, extra = {}) {
      const work = [];
      listeners.get("message")({ data: { type, ...extra }, ports: [], waitUntil: promise => work.push(promise) });
      await Promise.all(work);
    },
    async ask(type, extra = {}, owner = "page-A", onProgress) {
      const work = []; let result;
      listeners.get("message")({ data: { type, ...extra }, source: { id: owner }, ports: [{ postMessage: value => {
        if (value.progress) onProgress?.(value.progress); else result = value;
      } }], waitUntil: promise => work.push(promise) });
      await Promise.all(work);
      if (!result?.ok) throw new Error(result?.error || "没有响应");
      return result.value;
    },
    async dispatchFetch(event) { listeners.get("fetch")(event); },
    origins: () => requests.filter(request => new URL(request.url).pathname.endsWith("/content")),
    keyRequests: () => requests.filter(request => new URL(request.url).pathname.endsWith("/cache/keys")),
  };
  t.after(async () => { await h.message("tessera-cache:logout"); for (const timer of timers) clearTimeout(timer); });
  return h;
}

test("未同步授权期限时逐次验权，删除版本后清理本地条目", async t => {
  const h = harness(t);
  assert.deepEqual((await h.read(SECRET)).data, h.files.get(SECRET).data);
  assert.equal((await h.read(SECRET)).response.headers.get("X-Tessera-Cache"), "hit");
  assert.equal(h.keyRequests().length, 2);
  h.files.get(SECRET).valid = false;
  assert.equal((await h.read(SECRET)).response.status, 404);
  assert.equal([...h.entries.values()].filter(entry => entry.tier === "p").length, 0);
});

test("未同步授权期限时，服务端锁定仍阻止私密缓存读取", async t => {
  const h = harness(t);
  await h.read(SECRET);
  h.state.unlocked = false;
  const { response } = await h.read(SECRET);
  assert.equal(response.status, 423);
  assert.equal(response.headers.get("X-Tessera-Cache"), null);
  h.state.unlocked = true;
  await h.message("tessera-cache:access", { access: "new-grant" });
  const resumed = await h.read(SECRET, { access: "new-grant" });
  assert.equal(resumed.response.headers.get("X-Tessera-Cache"), "hit");
  assert.deepEqual(resumed.data, h.files.get(SECRET).data);
});

test("未同步授权期限时只合并并发验权，不复用已结束批次", async t => {
  const h = harness(t);
  const first = await Promise.all([h.read(SECRET), h.read(SECRET)]);
  assert.ok(first.every(item => item.response.status === 200));
  assert.equal(h.keyRequests().length, 1);
  await h.read(SECRET);
  assert.equal(h.keyRequests().length, 2);
});

test("有效私密授权期间，多次跳转视频进度和授权续期只获取一次版本密钥", async t => {
  const h = harness(t, { [SECRET]: bytes(3 * store.BLOCK + 137) });
  h.files.get(SECRET).type = "video/mp4";
  await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
  await h.read(SECRET, { media: true });
  const origins = h.origins().length;
  for (const start of [store.BLOCK + 17, 0, 2 * store.BLOCK + 33]) {
    h.state.clock += 60_000;
    await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + h.state.clock + 300_000 });
    const { response, data } = await h.read(SECRET, { media: true, range: `bytes=${start}-${start + 99}` });
    assert.equal(response.headers.get("X-Tessera-Cache"), "hit");
    assert.deepEqual(data, h.files.get(SECRET).data.subarray(start, start + 100));
  }
  assert.equal(h.keyRequests().length, 1);
  assert.equal(h.requests.filter(request => new URL(request.url).pathname === "/api/user/v1/private/cache/session").length, 1);
  assert.equal(h.origins().length, origins);
});

test("Worker 重启后向页面恢复有效授权，后续读取复用密钥", async t => {
  const h = harness(t);
  h.state.clients = [{ postMessage(_message, ports) { ports[0].postMessage({ access: "grant", expires: Date.now() + 300_000 }); ports[0].close(); } }];
  await h.read(SECRET);
  assert.equal((await h.read(SECRET)).response.headers.get("X-Tessera-Cache"), "hit");
  assert.equal(h.keyRequests().length, 1);
});

test("已复用的私密密钥在锁定、退出、重置、授权替换或到期后失效", async t => {
  for (const revoke of ["lock", "logout", "reset", "replace", "expire"]) await t.test(revoke, async t => {
    const h = harness(t);
    await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
    await h.read(SECRET);
    await h.read(SECRET);
    assert.equal(h.keyRequests().length, 1);
    h.state.unlocked = false;
    if (revoke === "lock") await h.message("tessera-cache:access", { access: "" });
    else if (revoke === "logout") { h.state.authenticated = false; await h.message("tessera-cache:logout"); }
    else if (revoke === "reset") await h.ask("tessera-cache:reset");
    else if (revoke === "replace") await h.message("tessera-cache:access", { access: "new-grant", expires: Date.now() + 300_000 });
    else h.state.clock += 300_001;
    const { response } = await h.read(SECRET);
    assert.equal(response.status, revoke === "logout" ? 401 : 423);
    assert.equal(response.headers.get("X-Tessera-Cache"), null);
  });
});

test("文件变更通知使私密版本重新验权，已删除文件不能命中旧密钥", async t => {
  const h = harness(t);
  await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
  await h.read(SECRET);
  h.files.get(SECRET).valid = false;
  await h.message("tessera-cache:nudge");
  assert.equal((await h.read(SECRET)).response.status, 404);
  assert.equal(h.keyRequests().length, 2);
  assert.equal(h.entries.size, 0);
});

test("获取私密密钥失败不留在复用缓存中，恢复后可重新获取", async t => {
  const h = harness(t);
  await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
  h.state.keysHook = async () => { throw new TypeError("network unavailable"); };
  await h.read(SECRET);
  h.state.keysHook = null;
  await h.read(SECRET);
  assert.equal((await h.read(SECRET)).response.headers.get("X-Tessera-Cache"), "hit");
  assert.equal(h.keyRequests().length, 2);
});

test("锁定期间返回的旧私密密钥不能重新恢复缓存上下文", { timeout: 3000 }, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
  h.state.keysHook = async (_request, _body, keys) => { entered.resolve(); await release.promise; return new Response(JSON.stringify({ keys })); };
  const reading = h.read(SECRET);
  await entered.promise;
  h.state.unlocked = false;
  await h.message("tessera-cache:access", { access: "" });
  release.resolve();
  assert.equal((await reading).response.status, 423);
  assert.equal(h.entries.size, 0);
});

test("私密缓存尚未交付时收到锁定通知，立即取消旧读取", { timeout: 3000 }, async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.message("tessera-cache:access", { access: "grant", expires: Date.now() + 300_000 });
  await h.read(SECRET);
  const getEntry = h.memory.getEntry;
  h.memory.getEntry = async key => { const entry = await getEntry(key); entered.resolve(); await release.promise; return entry; };
  const reading = h.read(SECRET);
  await entered.promise;
  h.state.unlocked = false;
  await h.message("tessera-cache:access", { access: "" });
  release.resolve();
  await assert.rejects(reading, { name: "AbortError" });
});

test("密钥接口返回 401 时撤销所有内存上下文，但保留本地密文", async t => {
  const h = harness(t);
  await h.read("file.bin");
  h.state.keysHook = async () => { h.state.authenticated = false; return new Response("{}", { status: 401 }); };
  assert.equal((await h.read(SECRET)).response.status, 401);
  assert.equal((await h.read("file.bin")).response.status, 401);
  assert.equal(h.entries.size, 1);
  assert.ok([...h.entries.values()][0].blocks.length > 0);
});

test("缓存纪元或密码更换后，重新取得上下文会使用新条目密钥", async t => {
  const h = harness(t);
  await h.read("file.bin");
  const old = [...h.entries.values()][0];
  const oldBase = await store.hkdf(h.state.key, "entry|" + h.files.get("file.bin").etag);
  const oldKey = await store.aesKey(await store.hkdf(oldBase, "key|" + h.files.get("file.bin").etag));
  h.state.key = new Uint8Array(32).fill(3);
  h.state.clock += 11 * 60_000;
  assert.deepEqual((await h.read("file.bin")).data, h.files.get("file.bin").data);
  const current = [...h.entries.values()].find(entry => entry.key !== old.key);
  assert.ok(current, "新纪元必须生成不同的条目编号");
  await assert.rejects(store.open(oldKey, h.blocks.get(current.key + "/0"), store.blockAad(current, 0)));
});

for (const index of [0, 1]) test(`第 ${index} 块损坏后，从未交付的位置自动回源`, async t => {
  const h = harness(t);
  await h.read("file.bin");
  const entry = [...h.entries.values()][0], key = `${entry.key}/${index}`;
  new Uint8Array(h.blocks.get(key))[20] ^= 1;
  const before = h.origins().length;
  assert.deepEqual((await h.read("file.bin")).data, h.files.get("file.bin").data);
  const recovery = h.origins().slice(before);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].headers.get("Range"), `bytes=${index * store.BLOCK}-${h.files.get("file.bin").data.length - 1}`);
  assert.equal(h.entries.size, 0);
});

test("缓存块存储读取失败时也能连续回源", async t => {
  const h = harness(t);
  await h.read("file.bin");
  h.memory.getBlock = async () => { throw new Error("IndexedDB 不可用"); };
  assert.deepEqual((await h.read("file.bin")).data, h.files.get("file.bin").data);
});

test("取消首次响应时立即中止停顿的上游读取", { timeout: 3000 }, async t => {
  const h = harness(t), stalled = deferred();
  let upstreamSignal;
  h.state.originHook = async (request, file) => {
    upstreamSignal = request.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(file.data.subarray(0, 65536));
        request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
      pull() { stalled.resolve(); },
    });
    return new Response(body, { headers: { "Content-Type": "image/png", "Content-Length": String(file.data.length), ETag: `"${file.etag}"` } });
  };
  const response = await h.request("file.bin"), reader = response.body.getReader();
  await reader.read();
  await stalled.promise;
  await new Promise(resolve => setImmediate(resolve));
  const canceled = reader.cancel();
  assert.equal(upstreamSignal.aborted, true);
  await canceled;
});

test("旧 ETag 的 Range 降级保留原始字节范围", async t => {
  const h = harness(t);
  const { response, data } = await h.read("file.bin", { version: "old-version", range: "bytes=1234-2345" });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), `bytes 1234-2345/${h.files.get("file.bin").data.length}`);
  assert.deepEqual(data, h.files.get("file.bin").data.subarray(1234, 2346));
  assert.equal(h.origins().at(-1).headers.get("Range"), "bytes=1234-2345");
  assert.equal(h.origins()[0].signal.aborted, true);
});

test("稀疏缓存和回源缺口仍然组成完整内容", async t => {
  const h = harness(t);
  await h.read("file.bin", { range: `bytes=0-${store.BLOCK - 1}` });
  await h.read("file.bin", { range: `bytes=${2 * store.BLOCK}-${3 * store.BLOCK - 1}` });
  const before = h.origins().length;
  assert.deepEqual((await h.read("file.bin")).data, h.files.get("file.bin").data);
  assert.equal(h.origins().length - before, 2);
});

test("手动缓存任意类型，取消后按已提交字节续传，完整下载命中本机", async t => {
  const h = harness(t, { "data.zip": bytes(9 * store.BLOCK + 137) });
  h.files.get("data.zip").type = "application/zip";
  const url = h.url("data.zip");
  await h.read("data.zip");
  assert.equal(h.entries.size, 0, "普通文件读取不自动启动整文件缓存");
  const start = await h.ask("tessera-cache:start", { id: "first", url });
  assert.equal(start.bytes, 0);
  const progress = [];
  const first = await h.ask("tessera-cache:step", { id: "first" }, "page-A", state => {
    assert.equal(state.bytes, [...h.entries.values()][0].bytes, "必须先提交事务，再报告进度");
    progress.push(state.bytes);
  });
  assert.equal(first.bytes, 8 * store.BLOCK);
  assert.equal(first.complete, false);
  assert.equal(progress.length, 8);
  await h.ask("tessera-cache:cancel", { id: "first" });
  const beforeDownload = h.origins().length;
  await h.read("data.zip", { download: true });
  assert.equal(h.origins().length, beforeDownload + 1, "未完成的下载仍走原有网络通道");
  assert.equal([...h.entries.values()][0].bytes, first.bytes);
  const resumed = await h.ask("tessera-cache:start", { id: "resume", url });
  assert.equal(resumed.bytes, first.bytes);
  const end = await h.ask("tessera-cache:step", { id: "resume" });
  assert.equal(end.complete, true);
  const before = h.origins().length;
  assert.deepEqual((await h.read("data.zip")).data, h.files.get("data.zip").data);
  const downloaded = await h.read("data.zip", { download: true });
  assert.deepEqual(downloaded.data, h.files.get("data.zip").data);
  assert.match(downloaded.response.headers.get("content-disposition"), /^attachment/);
  assert.equal(h.origins().length, before);
});

test("手动补全复用自动缓存的稀疏块，不重复回源", async t => {
  const h = harness(t);
  await h.read("file.bin", { range: `bytes=${store.BLOCK}-${2 * store.BLOCK - 1}` });
  const start = await h.ask("tessera-cache:start", { id: "fill", url: h.url("file.bin") });
  assert.equal(start.bytes, store.BLOCK);
  while (!(await h.ask("tessera-cache:step", { id: "fill" })).complete) { /* 每次补一段缺口 */ }
  const reads = h.origins().filter(request => request.method === "GET").map(request => request.headers.get("range"));
  assert.deepEqual(reads, [`bytes=${store.BLOCK}-${2 * store.BLOCK - 1}`, `bytes=0-${store.BLOCK - 1}`, `bytes=${2 * store.BLOCK}-${h.files.get("file.bin").data.length - 1}`]);
});

for (const tier of ["normal", "private"]) test(`手动缓存预检拒绝超过设备${tier === "normal" ? "普通层" : "私密层"}上限的文件`, async t => {
  const h = harness(t, { "file.bin": bytes(3 * store.BLOCK + 137), [SECRET]: bytes(2 * store.BLOCK) });
  if (tier === "normal") h.preferences.maxMiB = 1; else h.preferences.privateMaxMiB = 1;
  const name = tier === "normal" ? "file.bin" : SECRET;
  await assert.rejects(h.ask("tessera-cache:start", { id: "oversize", url: h.url(name) }), /超过本机缓存上限/);
  assert.equal(h.origins().filter(request => request.method === "GET").length, 0);
  assert.equal(h.entries.size, 0);
});

async function cacheFully(h, id, name) {
  await h.ask("tessera-cache:start", { id, url: h.url(name) });
  while (!(await h.ask("tessera-cache:step", { id })).complete) { /* 逐段补全 */ }
}

test("手动缓存优先：空间不够时先移除最久未用的自动缓存，保留其他手动缓存", async t => {
  const h = harness(t, { "a.bin": bytes(3 * store.BLOCK), "b.bin": bytes(3 * store.BLOCK), "c.bin": bytes(3 * store.BLOCK) });
  h.preferences.maxMiB = 7;
  await cacheFully(h, "a", "a.bin");
  await h.read("b.bin");
  assert.equal([...h.entries.values()].filter(entry => !entry.manual).length, 1);
  await cacheFully(h, "c", "c.bin");
  const left = [...h.entries.values()];
  assert.equal(left.length, 2);
  assert.ok(left.every(entry => entry.manual));
});

test("手动缓存已占满上限时直接提示用户处理，不删除其他手动缓存", async t => {
  const h = harness(t, { "a.bin": bytes(3 * store.BLOCK), "b.bin": bytes(3 * store.BLOCK), "c.bin": bytes(3 * store.BLOCK) });
  h.preferences.maxMiB = 7;
  await cacheFully(h, "a", "a.bin");
  await cacheFully(h, "b", "b.bin");
  await assert.rejects(h.ask("tessera-cache:start", { id: "c", url: h.url("c.bin") }), /已手动缓存/);
  assert.equal([...h.entries.values()].filter(entry => entry.manual && entry.blocks.length === 3).length, 2);
});

test("设置的容量超过浏览器配额时按配额生效", async t => {
  const h = harness(t, { "a.bin": bytes(3 * store.BLOCK) });
  h.preferences.maxMiB = 512000;
  h.state.quota = 2 * store.BLOCK;
  await assert.rejects(h.ask("tessera-cache:start", { id: "a", url: h.url("a.bin") }), /超过本机缓存上限 2 MB/);
  assert.equal(h.entries.size, 0);
});

test("配额写入失败会报错并保留已提交块，不误报完成", async t => {
  const h = harness(t), original = h.memory.putBlock;
  await h.ask("tessera-cache:start", { id: "quota", url: h.url("file.bin") });
  h.memory.putBlock = async (...args) => { if (args[1] === 1) throw new DOMException("disk full", "QuotaExceededError"); return original(...args); };
  await assert.rejects(h.ask("tessera-cache:step", { id: "quota" }), /存储空间不足/);
  assert.equal([...h.entries.values()][0].bytes, store.BLOCK);
  h.memory.putBlock = original;
  assert.equal((await h.ask("tessera-cache:start", { id: "retry", url: h.url("file.bin") })).bytes, store.BLOCK);
  assert.equal((await h.ask("tessera-cache:step", { id: "retry" })).complete, true);
});

test("取消手动缓存立即中止回源，已提交块可以继续使用", { timeout: 3000 }, async t => {
  const h = harness(t); let upstream;
  await h.ask("tessera-cache:start", { id: "cancel", url: h.url("file.bin") });
  h.state.originHook = async (request, file) => {
    upstream = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(file.data.subarray(0, store.BLOCK));
      request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    } }), { status: 206, headers: { "Content-Range": `bytes 0-${file.data.length - 1}/${file.data.length}`, ETag: `"${file.etag}"` } });
  };
  await assert.rejects(h.ask("tessera-cache:step", { id: "cancel" }, "page-A", () => { void h.ask("tessera-cache:cancel", { id: "cancel" }); }), /AbortError/);
  assert.equal(upstream.aborted, true);
  assert.equal([...h.entries.values()][0].bytes, store.BLOCK);
});

test("多个页面共享缓存名额，其他页面不能操作当前任务", async t => {
  const h = harness(t), url = h.url("file.bin");
  await h.ask("tessera-cache:start", { id: "a", url });
  assert.equal((await h.ask("tessera-cache:start", { id: "b", url }, "page-B")).busy, true);
  await h.ask("tessera-cache:cancel", { id: "a" }, "page-B");
  await assert.rejects(h.ask("tessera-cache:step", { id: "a" }, "page-B"), /任务已停止/);
  assert.equal((await h.ask("tessera-cache:step", { id: "a" })).complete, true);
  assert.equal((await h.ask("tessera-cache:start", { id: "b", url }, "page-B")).complete, true);
  assert.equal(h.origins().filter(request => request.method === "GET").length, 1);
});

test("补全期间文件覆盖会停止任务并清除旧版本", async t => {
  const h = harness(t, { "large.bin": bytes(9 * store.BLOCK) });
  await h.ask("tessera-cache:start", { id: "old", url: h.url("large.bin") });
  await h.ask("tessera-cache:step", { id: "old" });
  h.files.get("large.bin").etag = "replacement";
  await assert.rejects(h.ask("tessera-cache:step", { id: "old" }), /文件已变化/);
  assert.equal(h.entries.size, 0);
});

test("未加入缓存任务的旧版私密请求逐批验权，锁定后停止，重新解锁可以续传", async t => {
  const h = harness(t, { [SECRET]: bytes(9 * store.BLOCK) }), url = h.url(SECRET);
  await h.ask("tessera-cache:start", { id: "secret", url });
  await h.ask("tessera-cache:step", { id: "secret" });
  h.state.unlocked = false;
  await assert.rejects(h.ask("tessera-cache:step", { id: "secret" }), /解锁|AbortError/);
  const before = h.origins().filter(request => request.method === "GET").length;
  const entry = [...h.entries.values()][0];
  assert.equal(entry.bytes, 8 * store.BLOCK);
  assert.equal(JSON.stringify(entry).includes(SECRET), false);
  h.state.unlocked = true;
  await h.message("tessera-cache:access", { access: "fresh" });
  assert.equal((await h.ask("tessera-cache:start", { id: "secret-2", url: h.url(SECRET, { access: "fresh" }) })).bytes, entry.bytes);
  assert.equal((await h.ask("tessera-cache:step", { id: "secret-2" })).complete, true);
  assert.equal(h.origins().filter(request => request.method === "GET").length, before + 1);
  assert.ok(h.keyRequests().length >= 4);
});

test("已加入的私密文件夹任务锁定后继续缓存，排队文件可以开始，预览仍要求解锁", async t => {
  const root = ".tgdrive/private/selected/", first = root + "first.bin", second = root + "second.bin";
  const h = harness(t, { [first]: bytes(9 * store.BLOCK), [second]: bytes(100) });
  assert.equal(await h.ask("tessera-cache:queue-group", { id: "group", paths: [root], csrf: "csrf", access: "grant" }), undefined,
    "页面不接收缓存密钥，沿用已有任务编号");
  await h.ask("tessera-cache:start", { id: "first", group: "group", url: h.url(first) });
  await h.ask("tessera-cache:step", { id: "first" });
  h.state.unlocked = false;
  await h.message("tessera-cache:access", { access: "" });
  const page = await h.ask("tessera-cache:list-group", { id: "group", prefix: root });
  assert.equal(page.objects.length, 2);
  assert.equal((await h.ask("tessera-cache:step", { id: "first" })).complete, true);
  await h.ask("tessera-cache:start", { id: "second", group: "group", url: h.url(second) });
  assert.equal((await h.ask("tessera-cache:step", { id: "second" })).complete, true);
  assert.equal((await h.read(first)).response.status, 423, "缓存完成也不能在锁定时交付明文");
  h.state.unlocked = true;
  await h.message("tessera-cache:access", { access: "fresh" });
  const before = h.origins().filter(request => request.method === "GET").length;
  assert.deepEqual((await h.read(first, { access: "fresh" })).data, h.files.get(first).data);
  assert.equal(h.origins().filter(request => request.method === "GET").length, before, "解锁后复用后台写好的密文");
});

test("缓存范围与标签页绑定，其他页面不能使用或结束任务", async t => {
  const h = harness(t, { [SECRET]: bytes(100), ".tgdrive/private/other.bin": bytes(100) });
  await h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" });
  h.state.unlocked = false;
  await h.message("tessera-cache:access", { access: "" });
  await assert.rejects(h.ask("tessera-cache:start", { id: "foreign", group: "group", url: h.url(SECRET) }, "page-B"), /任务已结束/);
  await h.ask("tessera-cache:release-group", { id: "group" }, "page-B");
  await assert.rejects(h.ask("tessera-cache:start", { id: "outside", group: "group", url: h.url(".tgdrive/private/other.bin") }), /任务|版本/);
  await h.ask("tessera-cache:start", { id: "allowed", group: "group", url: h.url(SECRET) });
  assert.equal((await h.ask("tessera-cache:step", { id: "allowed" })).complete, true);
  await assert.rejects(h.ask("tessera-cache:queue-group", { id: "late", paths: [SECRET], csrf: "csrf", access: "grant" }), /解锁/);
});

test("锁定后长时间排队的任务无需续期，轮到时直接缓存", async t => {
  const h = harness(t, { [SECRET]: bytes(100) });
  await h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" });
  h.state.unlocked = false;
  await h.message("tessera-cache:access", { access: "" });
  h.state.clock += 2 * 60 * 60_000;
  await h.ask("tessera-cache:start", { id: "secret", group: "group", url: h.url(SECRET) });
  assert.equal((await h.ask("tessera-cache:step", { id: "secret" })).complete, true);
  assert.equal((await h.read(SECRET)).response.status, 423);
});

test("创建任务的迟到响应可跨越私密锁定，但不能跨越退出或移除任务", async t => {
  for (const mode of ["lock", "logout", "remove"]) {
    const h = harness(t, { [SECRET]: bytes(100) });
    const started = deferred(), pending = deferred();
    h.state.taskHook = async () => { started.resolve(); await pending.promise; };
    const creation = h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" });
    const result = creation.then(() => "ok", () => "aborted");
    await started.promise;
    h.state.unlocked = false;
    let removed;
    if (mode === "lock") await h.message("tessera-cache:access", { access: "" });
    if (mode === "logout") await h.message("tessera-cache:logout");
    if (mode === "remove") removed = h.ask("tessera-cache:release-group", { id: "group" });
    pending.resolve(); await removed;
    assert.equal(await result, mode === "lock" ? "ok" : "aborted");
    if (mode === "lock") {
      await h.ask("tessera-cache:start", { id: "secret", group: "group", url: h.url(SECRET) });
      assert.equal((await h.ask("tessera-cache:step", { id: "secret" })).complete, true);
    } else await assert.rejects(h.ask("tessera-cache:start", { id: "secret", group: "group", url: h.url(SECRET) }), /任务已结束/);
  }
});

test("重试沿用任务编号时，旧请求的清理不能删除新任务", async t => {
  const h = harness(t, { [SECRET]: bytes(100) });
  const started = deferred(), pending = deferred();
  h.state.taskHook = async () => { started.resolve(); await pending.promise; };
  const first = h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" }).catch(() => undefined);
  await started.promise;
  const retry = h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" });
  pending.resolve(); await first; await retry;
  assert.equal(h.requests.filter(request => request.url.endsWith("/tasks/release")).length, 1);
  await h.ask("tessera-cache:start", { id: "secret", group: "group", url: h.url(SECRET) });
  assert.equal((await h.ask("tessera-cache:step", { id: "secret" })).complete, true);
});

test("退出、关闭私密缓存策略与缓存密钥变化仍会终止缓存任务", async t => {
  for (const mode of ["logout", "policy", "epoch", "settings"]) {
    const h = harness(t, { [SECRET]: bytes(9 * store.BLOCK) });
    await h.ask("tessera-cache:queue-group", { id: "group", paths: [SECRET], csrf: "csrf", access: "grant" });
    await h.ask("tessera-cache:start", { id: "secret", group: "group", url: h.url(SECRET) });
    await h.ask("tessera-cache:step", { id: "secret" });
    if (mode === "logout") { h.state.authenticated = false; await h.message("tessera-cache:logout"); }
    if (mode === "policy") h.policy.private_enabled = false;
    if (mode === "epoch") h.state.privateKey = new Uint8Array(32).fill(8);
    if (mode === "settings") { h.preferences.private = false; await h.message("tessera-cache:settings"); }
    await assert.rejects(h.ask("tessera-cache:step", { id: "secret" }), /任务已停止|任务或文件版本|关闭/);
    assert.equal([...h.entries.values()][0].bytes, 8 * store.BLOCK);
  }
});

test("手动缓存为完整大小预留空间，并淘汰其他旧条目", async t => {
  const h = harness(t, { "old.bin": bytes(3 * store.BLOCK), "large.bin": bytes(9 * store.BLOCK) });
  h.preferences.maxMiB = 10;
  await h.read("old.bin");
  const previous = [...h.entries.keys()][0];
  await h.ask("tessera-cache:start", { id: "large", url: h.url("large.bin") });
  assert.equal(h.entries.has(previous), false);
  await h.ask("tessera-cache:step", { id: "large" });
  assert.equal([...h.entries.values()][0].bytes, 8 * store.BLOCK);
  assert.equal((await h.ask("tessera-cache:step", { id: "large" })).complete, true);
});

test("空文件可以完成缓存，设置关闭或移除缓存会停止任务", async t => {
  const h = harness(t, { "empty.txt": Buffer.alloc(0), "file.bin": bytes(store.BLOCK) });
  assert.equal((await h.ask("tessera-cache:start", { id: "empty", url: h.url("empty.txt") })).complete, true);
  assert.equal((await h.read("empty.txt")).response.status, 200);
  await h.ask("tessera-cache:start", { id: "file", url: h.url("file.bin") });
  await h.ask("tessera-cache:remove-file", { url: h.url("file.bin") });
  await assert.rejects(h.ask("tessera-cache:step", { id: "file" }), /任务已停止/);
  await h.ask("tessera-cache:start", { id: "file-2", url: h.url("file.bin") });
  await h.ask("tessera-cache:settings");
  await assert.rejects(h.ask("tessera-cache:step", { id: "file-2" }), /任务已停止/);
});

test("自动缓存已含完整媒体时，下载只读取本机且不启动新的写入", async t => {
  const h = harness(t);
  await h.read("file.bin");
  const before = h.origins().length;
  assert.deepEqual((await h.read("file.bin", { download: true })).data, h.files.get("file.bin").data);
  assert.equal(h.origins().length, before);
});

test("清除缓存可以中止仍在预检的任务，迟到响应不能重建条目", async t => {
  const h = harness(t), started = deferred(), waiting = deferred();
  h.state.originHook = async request => { if (request.method === "HEAD") { started.resolve(); await waiting.promise; } };
  const pending = h.ask("tessera-cache:start", { id: "preparing", url: h.url("file.bin") });
  await started.promise;
  await h.ask("tessera-cache:clear", { scope: "normal" });
  waiting.resolve();
  await assert.rejects(pending, /AbortError/);
  assert.equal(h.entries.size, 0);
});

test("关闭自动缓存视频时，播放器的 Range 请求只回源一次", async t => {
  const h = harness(t, { "movie.mp4": bytes(3 * store.BLOCK) });
  h.files.get("movie.mp4").type = "video/mp4";
  h.preferences.video = false;
  let response;
  const request = new Request(h.url("movie.mp4"), { headers: { Range: "bytes=1234-" } });
  Object.defineProperty(request, "destination", { value: "video" });
  const before = h.origins().length;
  // 直接驱动 fetch 事件，模拟 <video> 发出的请求（Node 的 Request 没有 destination）。
  await h.dispatchFetch({ request, respondWith: value => { response = value; } });
  const data = Buffer.from(await (await response).arrayBuffer());
  assert.deepEqual(data, h.files.get("movie.mp4").data.subarray(1234));
  assert.equal(h.origins().length - before, 1);
  assert.equal(h.origins().at(-1).headers.get("Range"), "bytes=1234-");
  assert.equal(h.entries.size, 0);
});

test("已缓存文件列表在 Worker 内搜索、筛选、分页，并可按条件移除", async t => {
  const fixtures = {};
  for (let index = 0; index < 7; index++) fixtures[`photos/p${index}.png`] = bytes(1000 + index);
  fixtures["music/song.mp3"] = bytes(2 * store.BLOCK + 5);
  const h = harness(t, fixtures);
  h.files.get("music/song.mp3").type = "audio/mpeg";
  for (const name of Object.keys(fixtures)) await h.read(name, name.endsWith(".mp3") ? { range: "bytes=0-100" } : {});
  const all = await h.ask("tessera-cache:items", { filter: { limit: 3 } });
  assert.equal(all.total, 8);
  assert.equal(all.items.length, 3);
  const next = await h.ask("tessera-cache:items", { filter: { limit: 3, offset: 6 } });
  assert.equal(next.items.length, 2);
  const audio = await h.ask("tessera-cache:items", { filter: { kind: "audio" } });
  assert.equal(JSON.stringify(audio.items.map(item => [item.path, item.complete])), JSON.stringify([["music/song.mp3", false]]));
  const partial = await h.ask("tessera-cache:items", { filter: { status: "partial" } });
  assert.equal(partial.total, 1);
  const search = await h.ask("tessera-cache:items", { filter: { query: "P3.PNG", sort: "name" } });
  assert.equal(search.items.map(item => item.path).join(), "photos/p3.png");
  const bySize = await h.ask("tessera-cache:items", { filter: { kind: "image", sort: "size", limit: 1 } });
  assert.equal(bySize.items[0].path, "photos/p6.png");
  assert.equal(await h.ask("tessera-cache:remove-items", { filter: { kind: "image" } }), 7);
  assert.equal((await h.ask("tessera-cache:items", { filter: {} })).total, 1);
  const summary = await h.ask("tessera-cache:stats");
  assert.equal(summary.normal.count, 1);
  assert.equal(summary.items, undefined, "统计不再解密条目");
});

test("自动缓存的单个文件最多占设备容量的一半，超出部分照常播放", async t => {
  const h = harness(t, { "big.bin": bytes(4 * store.BLOCK) });
  h.preferences.maxMiB = 4;
  const { data } = await h.read("big.bin");
  assert.deepEqual(data, h.files.get("big.bin").data);
  assert.equal([...h.entries.values()][0].bytes, 2 * store.BLOCK);
});

test("文件列表只取一次缓存索引：区分自动与手动，旧条目首次补标记", async t => {
  const h = harness(t, { "auto.png": bytes(2048), "kept.bin": bytes(2 * store.BLOCK + 9), "half.bin": bytes(3 * store.BLOCK), [SECRET]: bytes(65536) });
  await h.read("auto.png");
  const ids = name => `${name.startsWith(".tgdrive/private/") ? "p" : "n"}:${h.files.get(name).etag}`;
  await h.ask("tessera-cache:start", { id: "kept", url: h.url("kept.bin") });
  while (!(await h.ask("tessera-cache:step", { id: "kept" })).complete) { /* 补完 */ }
  await h.ask("tessera-cache:start", { id: "half", url: h.url("half.bin") });
  await h.ask("tessera-cache:cancel", { id: "half" });
  await h.read("half.bin", { range: `bytes=0-${store.BLOCK - 1}` });
  await h.ask("tessera-cache:start", { id: "secret", url: h.url(SECRET) });
  await h.ask("tessera-cache:step", { id: "secret" });
  // 模拟 1.11.0 留下的条目：明文没有手动标记，只有加密 info 里有。
  for (const entry of h.entries.values()) delete entry.manual;
  const keysBefore = h.keyRequests().length;
  const normal = await h.ask("tessera-cache:index", { private: false });
  const byId = Object.fromEntries(normal.map(item => [item.id, item]));
  assert.deepEqual(Object.keys(byId).sort(), [ids("auto.png"), ids("half.bin"), ids("kept.bin")].sort());
  assert.equal(byId[ids("auto.png")].manual, false);
  assert.equal(byId[ids("kept.bin")].manual, true);
  assert.equal(byId[ids("half.bin")].manual, true);
  assert.equal(byId[ids("kept.bin")].complete, true);
  assert.equal(byId[ids("half.bin")].complete, false);
  assert.equal(byId[ids("half.bin")].bytes, store.BLOCK);
  assert.equal(h.keyRequests().length, keysBefore, "列表状态不逐个申请私密条目密钥");
  const flags = [...h.entries.values()].filter(entry => entry.tier === "n").map(entry => entry.manual).sort();
  assert.equal(JSON.stringify(flags), JSON.stringify([false, true, true]), "普通层旧条目已补上标记");
  await h.message("tessera-cache:access", { access: "grant" });
  const withPrivate = await h.ask("tessera-cache:index", { private: true });
  assert.ok(withPrivate.some(item => item.id === ids(SECRET) && item.complete && item.manual));
  assert.ok(!normal.some(item => item.id === ids(SECRET)), "未解锁时不包含私密层");
});

test("媒体元素的 no-cors 请求：回源仍按块取 Range，已缓存的数据不会被当作文件变化清掉", async t => {
  const h = harness(t, { "song.wav": bytes(6 * store.BLOCK + 99) });
  const data = h.files.get("song.wav").data;
  const first = await h.read("song.wav", { media: true, range: "bytes=0-" });
  assert.deepEqual(first.data, data);
  const [entry] = h.entries.values();
  assert.equal(entry.blocks.length, 7, "第一次完整读取写满所有块");
  // 模拟浏览器换位置继续读：清掉后半段，再从中间读取，worker 必须自己带 Range 回源。
  entry.blocks = [0, 1, 2]; entry.bytes = 3 * store.BLOCK;
  for (const index of [3, 4, 5, 6]) h.blocks.delete(`${entry.key}/${index}`);
  const start = 3 * store.BLOCK + 10;
  const second = await h.read("song.wav", { media: true, range: `bytes=${start}-` });
  assert.equal(second.response.status, 206);
  assert.deepEqual(second.data, data.subarray(start));
  const after = h.entries.get(entry.key);
  assert.ok(after, "条目不能被删除");
  assert.deepEqual(after.blocks, [0, 1, 2, 3, 4, 5, 6]);
  const ranged = h.origins().filter(request => request.method === "GET").map(request => request.headers.get("range"));
  assert.ok(ranged.includes(`bytes=${3 * store.BLOCK}-${data.length - 1}`), ranged.join(","));
});

test("回源没有按 Range 返回（200）但版本相同，不能删除已缓存的数据", async t => {
  const h = harness(t, { "clip.bin": bytes(4 * store.BLOCK) });
  await h.read("clip.bin", { range: "bytes=0-" });
  const [entry] = h.entries.values();
  entry.blocks = [0, 1]; entry.bytes = 2 * store.BLOCK;
  for (const index of [2, 3]) h.blocks.delete(`${entry.key}/${index}`);
  h.state.originHook = request => request.headers.get("range")
    ? new Response(h.files.get("clip.bin").data, { status: 200, headers: { "Content-Type": "application/octet-stream", ETag: `"${h.files.get("clip.bin").etag}"` } }) : null;
  await h.read("clip.bin", { range: `bytes=${2 * store.BLOCK}-` }).catch(() => undefined);
  const after = h.entries.get(entry.key);
  assert.ok(after, "条目不能被删除");
  assert.deepEqual(after.blocks.slice(0, 2), [0, 1]);
});
