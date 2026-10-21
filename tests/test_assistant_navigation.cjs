// 验证页面侧也拦截锁定时的私密导航和隐藏抽屉；不创建 DOM、数据库或真实下载任务。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ stdin: { contents: 'export { executeClientTool } from "./web/src/user/assistant";', resolveDir: root },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", nodePaths: [path.join(root, "web/node_modules")] });
const loaded = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
const { executeClientTool } = loaded.exports;
const context = (privateUnlocked, onNavigate) => ({ open: true, privateUnlocked, page: false, cacheQueue: null,
  location: { view: "files", prefix: "" }, onNavigate });

test("私密空间只有私密目录与回收站；锁定时不导航", async () => {
  const calls = [], state = context(true, (...args) => calls.push(args));
  for (let replay = 0; replay < 3; replay++) {
    await assert.rejects(executeClientTool("ui_navigate", { view: "downloads", private: true }, state), /私密空间只有/);
  }
  await assert.rejects(executeClientTool("ui_navigate", { view: "files", private: true }, context(false, (...args) => calls.push(args))), /已锁定/);
  await assert.rejects(executeClientTool("ui_select", { folder: ".tgdrive/private/a/", paths: [] }, context(false, (...args) => calls.push(args))), /已锁定/);
  assert.deepEqual(calls, []);
});

test("隐藏抽屉与已取消调用不能执行导航", async () => {
  const calls = [], state = context(false, (...args) => calls.push(args));
  await assert.rejects(executeClientTool("ui_navigate", { view: "downloads" }, { ...state, open: false }), /对话已关闭/);
  await assert.rejects(executeClientTool("ui_navigate", { view: "downloads" }, state, AbortSignal.abort()), { name: "AbortError" });
  assert.deepEqual(calls, []);
});

test("用户打开普通对话时仍可导航到下载任务", async () => {
  const calls = [];
  const result = await executeClientTool("ui_navigate", { view: "downloads" }, context(false, (...args) => calls.push(args)));
  assert.deepEqual(calls, [["downloads", ""]]);
  assert.equal(result.ok, true);
});
