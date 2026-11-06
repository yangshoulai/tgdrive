// Run with: node --test tests/test_text_diff.cjs
// 文件助手编辑文本文件确认卡片的按行比较（web/src/text-diff.ts）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("../web/node_modules/typescript");

const source = fs.readFileSync(path.join(__dirname, "../web/src/text-diff.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function("module", "exports", compiled)(mod, mod.exports);
const { diffLines, diffParts } = mod.exports;

const render = lines => lines.map(line => ({ same: " ", add: "+", del: "-" })[line.type] + line.text);
function apply(before, lines) {
  // 按 same/add 还原新内容，按 same/del 还原旧内容，验证编辑序列完整。
  return [lines.filter(line => line.type !== "del").map(line => line.text), lines.filter(line => line.type !== "add").map(line => line.text)];
}

test("minimal line edits with line numbers", () => {
  const lines = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
  assert.deepEqual(render(lines), [" a", "-b", "+B", " c", " d", "+e"]);
  assert.deepEqual(lines.map(line => [line.oldNo ?? null, line.newNo ?? null]), [[1, 1], [2, null], [null, 2], [3, 3], [4, 4], [null, 5]]);
});

test("crlf, empty sides and random edits round-trip", () => {
  assert.deepEqual(render(diffLines("", "x\ny")), ["+x", "+y"]);
  assert.deepEqual(render(diffLines("x\r\ny\r\n", "x\ny\n")), [" x", " y"]);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 50; round++) {
    const a = Array.from({ length: 30 }, () => "abcde"[Math.floor(rand() * 5)]);
    const b = a.filter(() => rand() > 0.2).flatMap(line => rand() > 0.8 ? [line, "z"] : [line]);
    const [after, before] = apply(a, diffLines(a.join("\n"), b.join("\n")));
    assert.deepEqual(after, b);
    assert.deepEqual(before, a);
  }
});

test("large rewrites fall back without hanging, and unchanged runs collapse", () => {
  const a = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 6000 }, (_, i) => `new ${i}`).join("\n");
  const started = Date.now();
  const lines = diffLines(a, b);
  assert.ok(Date.now() - started < 2000);
  assert.equal(lines.filter(line => line.type === "del").length, 6000);
  const long = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const changed = [...long]; changed[50] = "changed";
  const parts = diffParts(diffLines(long.join("\n"), changed.join("\n")));
  assert.deepEqual(parts.map(part => part.type === "skip" ? `skip ${part.count}` : `lines ${part.lines.length}`), ["skip 47", "lines 8", "skip 46"]);
});
