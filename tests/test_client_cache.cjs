// 浏览器本地缓存的纯函数回归（docs/client-cache-design.md）：分段换算、缺失块范围、块加密与 AAD 绑定。
// 运行：node --test tests/test_client_cache.cjs（用 web/node_modules 里的 esbuild 现场打包 web/src/cache-store.ts）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));

const bundle = buildSync({ entryPoints: [path.join(__dirname, "../web/src/cache-store.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" });
const module_ = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module_, module_.exports);
const store = module_.exports;

test("Range 解析只接受单个区间", () => {
  assert.equal(store.parseRange(null), null);
  assert.deepEqual(store.parseRange("bytes=0-"), { start: 0, end: null });
  assert.deepEqual(store.parseRange("bytes=5-9"), { start: 5, end: 9 });
  assert.deepEqual(store.parseRange("bytes=-100"), { start: -100, end: null });
  assert.equal(store.parseRange("bytes=0-1,5-9"), undefined);
  assert.equal(store.parseRange("items=0-1"), undefined);
});

test("区间换算与越界", () => {
  assert.deepEqual(store.resolveRange(null, 10), { start: 0, end: 9 });
  assert.deepEqual(store.resolveRange({ start: 3, end: null }, 10), { start: 3, end: 9 });
  assert.deepEqual(store.resolveRange({ start: 3, end: 100 }, 10), { start: 3, end: 9 });
  assert.deepEqual(store.resolveRange({ start: -4, end: null }, 10), { start: 6, end: 9 });
  assert.equal(store.resolveRange({ start: 10, end: null }, 10), null);
});

test("一次回源到下一个已缓存的块为止", () => {
  assert.equal(store.missingRun([], 0, 9), 9);
  assert.equal(store.missingRun([4, 7], 1, 9), 3);
  assert.equal(store.missingRun([4, 7], 5, 9), 6);
  assert.equal(store.missingRun([4, 7], 8, 9), 9);
});

test("块加密绑定命名空间、层、编号与块序号", async () => {
  const material = store.fromB64u(store.b64u(crypto.getRandomValues(new Uint8Array(32))));
  const key = await store.aesKey(await store.hkdf(material, "key|v1"));
  const entry = { ns: "ns", tier: "n", id: "abc" };
  const data = new TextEncoder().encode("hello block");
  const sealed = await store.seal(key, data, store.blockAad(entry, 0));
  assert.deepEqual(Buffer.from(await store.open(key, sealed, store.blockAad(entry, 0))), Buffer.from(data));
  await assert.rejects(store.open(key, sealed, store.blockAad(entry, 1)), "调换块序号必须失败");
  await assert.rejects(store.open(key, sealed, store.blockAad({ ...entry, tier: "p" }, 0)));
  const other = await store.aesKey(await store.hkdf(material, "key|v2"));
  await assert.rejects(store.open(other, sealed, store.blockAad(entry, 0)), "不同版本的密钥不能解开");
});

test("派生是确定的，编号不泄露 ETag", async () => {
  const material = new Uint8Array(32).fill(7);
  const first = store.b64u(await store.hmac(material, "id|etag-1"));
  assert.equal(first, store.b64u(await store.hmac(material, "id|etag-1")));
  assert.notEqual(first, store.b64u(await store.hmac(material, "id|etag-2")));
  assert.ok(!first.includes("etag"));
});

test("Safari 默认不缓存视频", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  assert.equal(store.defaultSettings(safari).video, false);
  assert.equal(store.defaultSettings(chrome).video, true);
});

test("完成状态要求全部块提交，空文件也可完成", () => {
  const entry = { bytes: 2 * store.BLOCK, blocks: [0, 1] };
  assert.equal(store.fileCacheState(entry, 2 * store.BLOCK).complete, true);
  assert.equal(store.fileCacheState({ ...entry, blocks: [0, 2] }, 2 * store.BLOCK).complete, false);
  assert.equal(store.fileCacheState({ bytes: 0, blocks: [] }, 0).complete, true);
  assert.equal(store.fileCacheState(undefined, 0).complete, false);
});

test("IndexedDB 同步写入失败必须回滚此前排队的块索引", async () => {
  // 只模拟事务提交顺序：entries.put 已排队，而 blocks.put 同步抛错。
  // 实际存储函数必须主动 abort，不能让前一个写入独自提交。
  const saved = { key: "entry", blocks: [], bytes: 0 };
  let aborted = false, staged;
  const db = { transaction() {
    const tx = { error: null, objectStore(name) {
      return name === "entries" ? {
        get() { const r = { result: structuredClone(saved) }; queueMicrotask(() => r.onsuccess()); return r; },
        put(entry) { staged = structuredClone(entry); setImmediate(() => { if (!aborted) { Object.assign(saved, staged); tx.oncomplete(); } }); },
      } : { put() { throw new DOMException("disk full", "QuotaExceededError"); } };
    }, abort() { aborted = true; queueMicrotask(() => tx.onabort()); } };
    return tx;
  } };
  const indexedDB = { open() { const r = { result: db }; queueMicrotask(() => r.onsuccess()); return r; } };
  const isolated = { exports: {} };
  new Function("module", "exports", "indexedDB", bundle.outputFiles[0].text)(isolated, isolated.exports, indexedDB);
  await assert.rejects(isolated.exports.putBlock("entry", 0, new ArrayBuffer(32), 4), { name: "QuotaExceededError" });
  assert.equal(aborted, true);
  assert.deepEqual(saved.blocks, []);
  assert.equal(saved.bytes, 0);
});
