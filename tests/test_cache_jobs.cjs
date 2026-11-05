// 自动转手动时两份异步任务列表合并为一条；迟到回复不能让停止记录重新出现。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ stdin: { contents: 'export { mergeCacheJobs } from "./web/src/user/cache";', resolveDir: root },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", nodePaths: [path.join(root, "web/node_modules")] });
const loaded = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, require);
const { mergeCacheJobs } = loaded.exports;
const job = (id, origin, status, addedAt, key = "movie.mp4", etag = "version-1") => ({
  id, origin, status, addedAt, file: { key, etag, size: 1000, content_type: "video/mp4" }, bytes: 300, size: 1000, error: "", waiting: false,
});

test("自动转手动只显示一条任务，排队、处理与完成后的迟到结果均不重复", () => {
  const automatic = job("auto-1", "auto", "canceled", 100);
  for (const status of ["queued", "active", "paused", "error", "done"]) {
    const manual = job("manual-1", "manual", status, 200);
    assert.deepEqual(mergeCacheJobs([manual], [automatic]).map(job => job.id), ["manual-1"]);
    assert.equal(manual.bytes, 300);
  }
  assert.deepEqual(mergeCacheJobs([job("manual-1", "manual", "active", 100)], [job("late", "auto", "active", 200)]).map(job => job.id), ["manual-1"]);
});

test("保留其他版本、其他层和结束后新开始的自动读取，不修改输入列表", () => {
  const manual = job("manual-1", "manual", "done", 200);
  const automatic = [job("private", "auto", "active", 300, ".tgdrive/private/movie.mp4"),
    job("different", "auto", "canceled", 100, "movie.mp4", "version-2"), job("later", "auto", "active", 400)];
  assert.deepEqual(mergeCacheJobs([manual], automatic).map(job => job.id), ["different", "manual-1", "private", "later"]);
  assert.deepEqual(automatic.map(job => job.id), ["private", "different", "later"]);
});
