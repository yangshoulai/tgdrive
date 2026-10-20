// 确认区队列只保留未处理请求，不复活历史表单。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ stdin: { contents: 'export { pendingReviews } from "./web/src/user/assistant-review";', resolveDir: root },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", nodePaths: [path.join(root, "web/node_modules")] });
const loaded = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
const { pendingReviews } = loaded.exports;
const action = (id, status = "pending", expires_at = 100) => ({ id, status, expires_at, created_at: 1, kind: "move" });
const question = { seq: 2, role: "tool", created_at: 2, event: { type: "question", question: "规则？", options: [] } };

test("已完成、已拒绝和过期操作不进入队列，范围请求可恢复", () => {
  const detail = { actions: [action("done", "done"), action("rejected", "rejected"), action("expired", "pending", 1),
    action("active"), { ...action("scope"), kind: "scope" }], messages: [] };
  assert.deepEqual(pendingReviews(detail, [], null, 2000).map(item => [item.id, item.kind]), [["active", "action"], ["scope", "scope"]]);
});

test("开放问题支持空选项，回答后不再出现，运行中等待回复结束", () => {
  const detail = { actions: [], messages: [question] };
  assert.equal(pendingReviews(detail, [], null, 2000)[0].kind, "question");
  assert.equal(pendingReviews(detail, [], "run", 2000).length, 0);
  detail.messages.push({ seq: 3, role: "user", text: "按年月命名" });
  assert.equal(pendingReviews(detail, [], null, 2000).length, 0);
});

test("即时 HTTP 审批只属于当前运行，决定后移除", () => {
  const detail = { actions: [], messages: [] };
  const approval = { callId: "http", runId: "r", status: "pending", expires: 10000, requestedAt: 1 };
  assert.equal(pendingReviews(detail, [approval], "r", 2000).length, 1);
  assert.equal(pendingReviews(detail, [approval], "other", 2000).length, 0);
  assert.equal(pendingReviews(detail, [{ ...approval, status: "approved" }], "r", 2000).length, 0);
  assert.equal(pendingReviews(detail, [approval], "r", 10000).length, 0);
});
