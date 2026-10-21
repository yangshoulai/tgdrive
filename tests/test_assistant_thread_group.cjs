// 消息分组：被后续步骤取代的回复回到时间线中原来的位置，不能留在末尾当作最终回复。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ stdin: { contents: 'export { group } from "./web/src/user/assistant-thread";', resolveDir: root },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", nodePaths: [path.join(root, "web/node_modules")] });
const loaded = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
const { group } = loaded.exports;

let seq = 0;
const user = text => ({ seq: ++seq, role: "user", run_id: "r1", text });
const say = (run, text, calls = []) => ({ seq: ++seq, role: "assistant", run_id: run, text, tool_calls: calls });
const tool = (run, name) => ({ seq: ++seq, role: "tool", run_id: run, call_id: `c${seq}`, name, status: "ok" });
const call = name => [{ id: `c${seq + 1}`, name, arguments: "{}" }];
const shape = turn => turn.steps.map(step => step.kind === "note" ? `note:${step.text}` : step.kind === "tool" ? `tool:${step.message.name}` : step.kind);

test("工具之间的说明按顺序出现在时间线里", () => {
  seq = 0;
  const [item] = group([user("下载相册"), say("r1", "先分析第 1 页", call("analyze_page")), tool("r1", "analyze_page"),
    say("r1", "共 12 张，开始下载", call("propose_downloads")), tool("r1", "propose_downloads"), say("r1", "已全部提交")]);
  assert.deepEqual(shape(item.turn), ["note:先分析第 1 页", "tool:analyze_page", "note:共 12 张，开始下载", "tool:propose_downloads"]);
  assert.equal(item.turn.answer.text, "已全部提交");
});

test("确认后续跑的运行没有新回复时，旧回复回到原位而不是留在最后", () => {
  seq = 0;
  const [item] = group([user("下载相册"), say("r1", "", call("propose_downloads")), tool("r1", "propose_downloads"),
    say("r1", "确认后我会自动继续处理"), say("r2", "", call("list_downloads")), tool("r2", "list_downloads")]);
  assert.equal(item.turn.answer, undefined);
  assert.deepEqual(shape(item.turn), ["tool:propose_downloads", "note:确认后我会自动继续处理", "tool:list_downloads"]);
});

test("续跑有新回复时，旧回复按顺序留在时间线中", () => {
  seq = 0;
  const [item] = group([user("下载相册"), say("r1", "", call("propose_downloads")), tool("r1", "propose_downloads"),
    say("r1", "请确认下载"), say("r2", "", call("list_downloads")), tool("r2", "list_downloads"), say("r2", "12 个任务都已完成")]);
  assert.deepEqual(shape(item.turn), ["tool:propose_downloads", "note:请确认下载", "tool:list_downloads"]);
  assert.equal(item.turn.answer.text, "12 个任务都已完成");
});
