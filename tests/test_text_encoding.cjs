// 文本编辑按原编码写回：解码记录编码与 BOM，编码后与原文件逐字节一致。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));

const load = entry => {
  const bundle = buildSync({ entryPoints: [path.join(__dirname, "../web/src", entry)], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" });
  const module_ = { exports: {} };
  new Function("module", "exports", bundle.outputFiles[0].text)(module_, module_.exports);
  return module_.exports;
};
const { encodeText } = load("text-encoding.ts");
const { decodeText } = load("preview-data.ts");

const roundTrip = bytes => {
  const decoded = decodeText(bytes);
  return { decoded, encoded: encodeText(decoded.text, decoded.encoding, decoded.bom) };
};

test("UTF-8 保留有无 BOM", () => {
  for (const bytes of [Buffer.from("第一行\r\n# 标题 😀\n"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2\n")])]) {
    const { decoded, encoded } = roundTrip(new Uint8Array(bytes));
    assert.equal(decoded.encoding, "utf-8");
    assert.deepEqual(Buffer.from(encoded), bytes);
  }
});

test("带 BOM 的 UTF-16 写回同一字节序", () => {
  const text = "日志 log 😀\r\n";
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const be = Buffer.from(le); be.swap16(); be[0] = 0xfe; be[1] = 0xff;
  be.set(Buffer.from(text, "utf16le").swap16(), 2);
  for (const [bytes, name] of [[le, "utf-16le"], [be, "utf-16be"]]) {
    const { decoded, encoded } = roundTrip(new Uint8Array(bytes));
    assert.equal(decoded.encoding, name);
    assert.equal(decoded.text, text);
    assert.deepEqual(Buffer.from(encoded), bytes);
  }
});

test("GB18030（GBK）文件按原编码写回，含四字节字符", () => {
  // 「中文，编码测试」的 GBK 字节，加上四字节区的第一个字符（U+0080，81 30 81 30）和增补平面字符（U+1F600，94 39 FC 36）。
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xa3, 0xac, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4, 0x0d, 0x0a, 0x81, 0x30, 0x81, 0x30, 0x94, 0x39, 0xfc, 0x36]);
  const { decoded, encoded } = roundTrip(new Uint8Array(gbk));
  assert.equal(decoded.encoding, "gb18030");
  assert.equal(decoded.exact, true);
  assert.equal(decoded.text, "中文，编码测试\r\n\u0080😀");
  assert.deepEqual(Buffer.from(encoded), gbk);
  const edited = encodeText(decoded.text.replace("测试", "测试完成"), "gb18030", false);
  assert.equal(new TextDecoder("gb18030").decode(edited), "中文，编码测试完成\r\n\u0080😀");
});

test("无法识别的字节标记为不能安全编辑", () => {
  const decoded = decodeText(new Uint8Array([0x61, 0xff, 0x62]));
  assert.equal(decoded.exact, false);
});

test("所有有效的 GB18030 双字节码都能原样写回", () => {
  const decoder = new TextDecoder("gb18030", { fatal: true }), mismatched = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
    if (trail === 0x7f) continue;
    let text;
    try { text = decoder.decode(new Uint8Array([lead, trail])); } catch { continue; }
    const back = encodeText(text, "gb18030", false);
    if (back.length !== 2 || back[0] !== lead || back[1] !== trail) mismatched.push(((lead << 8) | trail).toString(16));
  }
  // 0xA3A0 与 0xA1A1 在 WHATWG 编码标准里都解为 U+3000（全角空格），写回时统一为 0xA1A1，与标准编码器一致。
  assert.deepEqual(mismatched, ["a3a0"]);
});
