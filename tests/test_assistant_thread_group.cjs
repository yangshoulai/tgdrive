// 消息分组：被后续步骤取代的回复回到时间线中原来的位置，不能留在末尾当作最终回复。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ stdin: { contents: `export { group } from "./web/src/user/assistant-thread";
  import { Thread } from "./web/src/user/assistant-thread";
  import { createElement } from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  export const renderThread = props => renderToStaticMarkup(createElement(Thread, props));`, resolveDir: root },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", nodePaths: [path.join(root, "web/node_modules")] });
const loaded = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, require);
const { group, renderThread } = loaded.exports;

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

const view = (messages, live = null, actions = []) => renderThread({ detail: { conversation: { id: "chat-1" }, messages, actions },
  live, runId: live ? "r1" : null, httpApprovals: [], modelLabel: () => "", onActionChanged: () => undefined, onReview: () => undefined });
const running = { reasoning: "", reasoningStartedAt: null, streaming: "", tools: [], phase: "tool" };

test("进度说明显示一行摘要并可展开，普通进度不冒充思考", () => {
  seq = 0;
  const html = view([user("分析相册"), say("r1", "已确认列表共有四页", call("collect_links")), tool("r1", "collect_links")],
    { ...running, phase: "writing", streaming: "正在核对相册与已有文件" });
  assert.equal((html.match(/class="ai-step ai-note/g) ?? []).length, 2);
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 3);
  assert.match(html, /进度说明/);
  assert.match(html, /已确认列表共有四页/);
  assert.match(html, /正在核对相册与已有文件/);
  assert.doesNotMatch(html, /思考中|ai-step ai-thinking/);
});

test("等待模型只显示等待状态，真实 reasoning 才生成思考节点", () => {
  seq = 0;
  const messages = [user("分析相册")];
  const waiting = view(messages, { ...running, phase: "thinking" });
  assert.match(waiting, /等待模型响应/);
  assert.doesNotMatch(waiting, /ai-step ai-thinking|思考中/);
  const streaming = view(messages, { ...running, phase: "thinking", reasoning: "逐页检查分页与链接结构" });
  assert.match(streaming, /思考中/);
  assert.doesNotMatch(streaming, /逐页检查分页与链接结构/);
});

test("完成后的最终回复保持正常展示，过程说明仍在时间线", () => {
  seq = 0;
  const html = view([user("分析相册"), say("r1", "中途核对已有目录", call("list_folder")), tool("r1", "list_folder"), say("r1", "已经整理完成")]);
  assert.match(html, /class="ai-answer"[\s\S]*已经整理完成/);
  assert.doesNotMatch(html, /中途核对已有目录/);
});

const actionMessage = (event = {}) => ({ ...tool("r1", "propose_downloads"),
  event: { type: "action", action_id: "a1", kind: "downloads", count: 2, auto: true, ...event } });
const action = (status, extra = {}) => ({ id: "a1", kind: "downloads", count: 2, status,
  payload: { auto: true }, created_at: 1, expires_at: Date.now() / 1000 + 60, decided_at: 2, ...extra });

test("自动执行的操作详情未到达时显示加载状态，真实结果到达后显示已自动执行", () => {
  seq = 0;
  const messages = [user("保存这两项"), actionMessage()];
  const loading = view(messages, running);
  assert.match(loading, /正在获取状态/);
  assert.doesNotMatch(loading, /已过期|已自动执行|等待确认|去处理|ai-action-progress/);
  const done = view(messages, running, [action("done", { result: { ok: 2, skipped: 0, failed: 0 } })]);
  assert.match(done, /已自动执行/);
  assert.match(done, /成功 2/);
  assert.doesNotMatch(done, /已过期|正在获取状态|去处理/);
});

test("缺失详情的决定节点在运行结束及较长时间线中仍可见，范围请求也不误报过期", () => {
  seq = 0;
  const messages = [user("保存文件"), actionMessage()];
  for (let i = 0; i < 10; i++) messages.push(tool("r1", "list_folder"));
  const html = view(messages);
  assert.match(html, /正在获取状态/);
  assert.doesNotMatch(html, /已过期|去处理/);
  const scope = view([user("整理文件"), actionMessage({ type: "scope_request", from: "/当前/", to: "/" })], running);
  assert.match(scope, /扩大访问范围/);
  assert.match(scope, /正在获取状态/);
  assert.doesNotMatch(scope, /已过期|等待确认|去处理/);
});

test("自动执行只在成功终态显示完成，准备中和执行中不因确认有效期已过而显示过期", () => {
  seq = 0;
  const messages = [user("保存文件"), actionMessage()];
  for (const [status, label] of [["confirmed", "准备执行"], ["running", "执行中"], ["partial", "部分完成"], ["failed", "执行失败"], ["cancelled", "已取消"]]) {
    const html = view(messages, running, [action(status, { expires_at: 1 })]);
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /已自动执行|已过期|等待确认|去处理/);
  }
});

test("审批操作仍显示等待确认，明确过期或待确认已超时才显示已过期", () => {
  seq = 0;
  const messages = [user("保存文件"), actionMessage({ auto: false })];
  const pending = action("pending", { payload: {} });
  const html = view(messages, running, [pending]);
  assert.match(html, /等待确认/);
  assert.match(html, /去处理/);
  for (const expired of [{ ...pending, status: "expired" }, { ...pending, expires_at: 1 }]) {
    const html = view(messages, running, [expired]);
    assert.match(html, /已过期/);
    assert.doesNotMatch(html, /已自动执行|正在获取状态|等待确认|去处理/);
  }
});
