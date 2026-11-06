// 预览读取只把真实超限标记为截断；小文件的短范围响应需要补救，不能误报大小或进入编辑。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../web/src/preview-data.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" }).outputFiles[0].text;
const LIMIT = 2 * 1024 * 1024;
const lyrics = Buffer.from(Array.from({ length: 100 }, (_, index) => `[00:${String(index % 60).padStart(2, "0")}.00]第 ${index + 1} 行歌词\n`).join(""));
const signal = () => new AbortController().signal;
const response = (body, headers = {}, status = 200) => new Response(body, { status, headers });

function reader(fetcher) {
  const calls = [], module_ = { exports: {} };
  new Function("module", "exports", "fetch", bundle)(module_, module_.exports, async (url, init) => {
    calls.push({ url, ...init, headers: new Headers(init.headers) });
    return fetcher(calls.length, calls.at(-1));
  });
  return { read: module_.exports.readPreviewText, calls };
}

test("几 KB 歌词的完整范围响应正常显示，不重复读取", async () => {
  const h = reader(() => response(lyrics, { "Content-Range": `bytes 0-${lyrics.length - 1}/${lyrics.length}`, "Content-Length": String(lyrics.length) }, 206));
  const result = await h.read("/lyrics", LIMIT, signal());
  assert.equal(result.text, lyrics.toString());
  assert.equal(result.truncated, false);
  assert.equal(result.total, lyrics.length);
  assert.equal(h.calls.length, 1);
});

test("小歌词只收到部分范围时，完整重读后成功，不能误报超过 2 MB", async () => {
  const controller = new AbortController();
  const h = reader(attempt => attempt === 1
    ? response(lyrics.subarray(0, 1024), { "Content-Range": `bytes 0-1023/${lyrics.length}`, "Content-Length": "1024" }, 206)
    : response(lyrics, { "Content-Length": String(lyrics.length) }));
  const result = await h.read("/lyrics", LIMIT, controller.signal);
  assert.equal(result.text, lyrics.toString());
  assert.equal(result.truncated, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].headers.get("Range"), `bytes=0-${LIMIT}`);
  assert.equal(h.calls[1].headers.has("Range"), false);
  assert.equal(h.calls[1].cache, "reload");
  assert.equal(h.calls[1].credentials, "include");
  assert.equal(h.calls[1].signal, controller.signal);
});

test("响应正文比声明大小短时也尝试完整重读", async () => {
  const h = reader(attempt => response(attempt === 1 ? lyrics.subarray(0, 1024) : lyrics, { "Content-Length": String(lyrics.length) }));
  assert.equal((await h.read("/lyrics", LIMIT, signal())).text, lyrics.toString());
  assert.equal(h.calls.length, 2);
});

test("已解压文本不和压缩传输长度比较，仍按实际读取字节限制大小", async () => {
  const h = reader(() => response(lyrics, { "Content-Encoding": "gzip", "Content-Length": String(lyrics.length + 20) }));
  const result = await h.read("/encoded", LIMIT, signal());
  assert.equal(result.text, lyrics.toString());
  assert.equal(result.truncated, false);
  assert.equal(h.calls.length, 1);
  const large = reader(() => response("x".repeat(65), { "Content-Encoding": "gzip", "Content-Length": "20" }));
  assert.equal((await large.read("/large-encoded", 64, signal())).truncated, true);
});

test("再次读取仍不完整时报告读取失败，不把残缺文本交给播放器或编辑器", async () => {
  const h = reader(() => response(lyrics.subarray(0, 1024), { "Content-Range": `bytes 0-1023/${lyrics.length}` }, 206));
  await assert.rejects(h.read("/lyrics", LIMIT, signal()), /文件读取不完整，请重试/);
  assert.equal(h.calls.length, 2);
});

test("真实超过上限的文件仍标记截断，不进入完整重读", async () => {
  const h = reader(() => response("x".repeat(65), { "Content-Range": "bytes 0-64/5000" }, 206));
  const result = await h.read("/large", 64, signal());
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 64);
  assert.equal(result.total, 5000);
  assert.equal(h.calls.length, 1);
});

test("完整重读忽略 Range 且文件已变大时仍受字节上限约束并取消流", async () => {
  let canceled = false, pulls = 0;
  const h = reader(attempt => attempt === 1
    ? response("x", { "Content-Range": "bytes 0-0/32" }, 206)
    : response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(32).fill(120)); }, cancel() { canceled = true; } })));
  const result = await h.read("/changed", 64, signal());
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 64);
  assert.equal(canceled, true);
  assert.ok(pulls <= 4);
  assert.equal(h.calls.length, 2);
});

test("恰好达到上限与没有长度头的小文件不会误判超限", async () => {
  for (const headers of [{ "Content-Length": "64" }, {}]) {
    const h = reader(() => response("x".repeat(64), headers));
    const result = await h.read("/exact", 64, signal());
    assert.equal(result.truncated, false);
    assert.equal(result.text.length, 64);
    assert.equal(h.calls.length, 1);
  }
});

test("切歌取消后不重读旧歌词", async () => {
  const controller = new AbortController();
  const h = reader(() => {
    controller.abort();
    return response("x", { "Content-Range": "bytes 0-0/32" }, 206);
  });
  await assert.rejects(h.read("/canceled", 64, controller.signal), { name: "AbortError" });
  assert.equal(h.calls.length, 1);
});

test("权限错误不重读；空文件的 416 仍正常返回空文本", async () => {
  const denied = reader(() => response("", {}, 403));
  await assert.rejects(denied.read("/private", LIMIT, signal()), /无法读取文件（403）/);
  assert.equal(denied.calls.length, 1);
  const empty = reader(() => response(null, { "Content-Range": "bytes */0" }, 416));
  const result = await empty.read("/empty", LIMIT, signal());
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
  assert.equal(result.total, 0);
});
