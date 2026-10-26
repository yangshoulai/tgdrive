// Read-only update review helper. Never imports or executes the upstream userscript.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "UPSTREAM.json"), "utf8"));
const baselinePath = resolve(root, manifest.snapshot);
const baseline = readFileSync(baselinePath);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
if (digest(baseline) !== manifest.sha256) {
  console.error("上游快照 SHA-256 与 UPSTREAM.json 不符，请先恢复原始快照。");
  process.exit(1);
}
const args = process.argv.slice(2);
console.log(`基线：LinkSwift ${manifest.version} / ${manifest.commit}`);
console.log(`SHA-256：${manifest.sha256}`);
if (args.length === 1 && args[0] === "--verify") process.exit(0);
if (!args.length || args.filter(arg => arg !== "--diff").length !== 1 || args.some(arg => arg.startsWith("--") && arg !== "--diff")) {
  console.error("用法：node third_party/linkswift/compare.mjs --verify\n      node third_party/linkswift/compare.mjs <下载的新上游源码> [--diff]");
  process.exit(2);
}
const nextPath = resolve(args.find(arg => arg !== "--diff"));
const next = readFileSync(nextPath);
console.log(`待比较 SHA-256：${digest(next)}`);
if (baseline.equals(next)) {
  console.log("与内置基线一致。");
  process.exit(0);
}

// Upstream declares each adapter as a top-level object with one tab of indentation.
// Compare whole sections, including shared config/helpers: UI-only changes may also be reported.
function sections(bytes) {
  const source = bytes.toString("utf8").replace(/\r\n/g, "\n");
  const starts = [...source.matchAll(/^\t(?:const|let|var)\s+([\w$]+)\s*=\s*\{/gm)];
  const result = new Map([["header", source.slice(0, starts[0]?.index ?? source.length)]]);
  starts.forEach((match, index) => result.set(match[1], source.slice(match.index, starts[index + 1]?.index ?? source.length)));
  return result;
}
const previousSections = sections(baseline), nextSections = sections(next);
const changed = [...new Set([...previousSections.keys(), ...nextSections.keys()])].filter(name => previousSections.get(name) !== nextSections.get(name));
console.log(`变化区域：${changed.length ? changed.join("、") : "文件格式或换行"}`);
console.log("请对照 UPSTREAM.json 的函数映射迁移取链变化，验证后更新适配代码、快照、来源版本和脚本版本。");
console.log("此工具只比对源码，不替换或执行任何代码。");
if (args.includes("--diff")) {
  const result = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--", baselinePath, nextPath], { stdio: "inherit", shell: false });
  if (result.error || result.status > 1 || result.status === null) {
    console.error("无法生成 git diff，请确认 Git 可用。");
    process.exit(1);
  }
}
