// 预览解析：CSV 分隔符与引号、JSONC 注释、Notebook 新旧格式、字体的名称／字形数／字符表（TrueType 与 WOFF）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));

const bundle = buildSync({ entryPoints: [path.join(__dirname, "../web/src/preview-parsers.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" });
const module_ = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module_, module_.exports);
const { parseDelimited, detectDelimiter, stripJsonComments, parseNotebook, readFontInfo } = module_.exports;

test("CSV 引号里的分隔符、换行与转义的双引号", () => {
  const rows = parseDelimited('﻿名称,备注\r\n"苹果, 红",“甜”\n"多行\n文本","他说""好"""\n', ",");
  assert.deepEqual(rows, [["名称", "备注"], ["苹果, 红", "“甜”"], ["多行\n文本", '他说"好"']]);
});

test("按字段数是否一致判断分隔符，.tsv 固定为制表符", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6\n", "x.csv"), ";");
  assert.equal(detectDelimiter("a,b\n1,2\n", "x.csv"), ",");
  assert.equal(detectDelimiter("a|b|c\n1|2|3\n", "x.txt"), "|");
  assert.equal(detectDelimiter("a,b\n", "data.tsv"), "\t");
});

test("JSONC 去掉注释与末尾逗号，字符串里的 // 保留", () => {
  const text = '{\n  // 注释\n  "url": "https://example.com/a", /* 块注释 */\n  "list": [1, 2,],\n}';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: "https://example.com/a", list: [1, 2] });
});

test("Notebook：nbformat 4 与 nbformat 3（worksheets、input）", () => {
  const v4 = parseNotebook(JSON.stringify({ nbformat: 4, metadata: { kernelspec: { display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", source: ["print(1)"] }] }));
  assert.equal(v4.kernel, "Python 3");
  assert.equal(v4.cells.length, 1);
  const v3 = parseNotebook(JSON.stringify({ nbformat: 3, metadata: {}, worksheets: [{ cells: [{ cell_type: "code", input: ["x = 1"] }, { cell_type: "markdown", source: "# 标题" }] }] }));
  assert.deepEqual(v3.cells.map(cell => cell.source), [["x = 1"], "# 标题"]);
  assert.equal(v3.language, "python");
  assert.throws(() => parseNotebook("不是 JSON"));
});

/** 最小的 TrueType：name（Windows UTF-16BE 中英文名称）、maxp（字形数）、cmap 格式 4（A–C 与「中」）。 */
function fakeFont() {
  const utf16 = text => { const buffer = Buffer.from(text, "utf16le"); buffer.swap16(); return buffer; };
  const records = [[1, 0x0409, "Test Sans"], [1, 0x0804, "测试黑体"], [2, 0x0409, "Regular"], [5, 0x0409, "Version 1.0"]];
  const strings = records.map(([, , text]) => utf16(text));
  const name = Buffer.alloc(6 + records.length * 12);
  name.writeUInt16BE(0, 0); name.writeUInt16BE(records.length, 2); name.writeUInt16BE(name.length, 4);
  let offset = 0;
  records.forEach(([id, language], index) => {
    const at = 6 + index * 12;
    name.writeUInt16BE(3, at); name.writeUInt16BE(1, at + 2); name.writeUInt16BE(language, at + 4); name.writeUInt16BE(id, at + 6);
    name.writeUInt16BE(strings[index].length, at + 8); name.writeUInt16BE(offset, at + 10);
    offset += strings[index].length;
  });
  const maxp = Buffer.alloc(6); maxp.writeUInt32BE(0x00005000, 0); maxp.writeUInt16BE(42, 4);
  // cmap 格式 4：两个区段（0x41–0x43、0x4E2D）加结尾的 0xFFFF。
  const segments = [[0x41, 0x43, -0x40], [0x4e2d, 0x4e2d, -0x4e29], [0xffff, 0xffff, 1]];
  const sub = Buffer.alloc(16 + segments.length * 8);
  sub.writeUInt16BE(4, 0); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(segments.length * 2, 6);
  segments.forEach(([start, end, delta], index) => {
    sub.writeUInt16BE(end, 14 + index * 2);
    sub.writeUInt16BE(start, 16 + segments.length * 2 + index * 2);
    sub.writeInt16BE(delta, 16 + segments.length * 4 + index * 2);
    sub.writeUInt16BE(0, 16 + segments.length * 6 + index * 2);
  });
  const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
  const tables = [["cmap", cmap], ["maxp", maxp], ["name", Buffer.concat([name, ...strings])]];
  const header = Buffer.alloc(12 + tables.length * 16);
  header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(tables.length, 4);
  let position = header.length;
  const bodies = tables.map(([tag, data], index) => {
    const at = 12 + index * 16;
    header.write(tag, at, "latin1"); header.writeUInt32BE(position, at + 8); header.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
    position += padded.length;
    return padded;
  });
  return { sfnt: Buffer.concat([header, ...bodies]), tables };
}

/** 同一组表包成 WOFF（每个表用 zlib 压缩）。 */
function toWoff(tables) {
  const directory = Buffer.alloc(44 + tables.length * 20);
  directory.write("wOFF", 0, "latin1"); directory.writeUInt32BE(0x00010000, 4); directory.writeUInt16BE(tables.length, 12);
  let position = directory.length;
  const bodies = tables.map(([tag, data], index) => {
    const packed = zlib.deflateSync(data), at = 44 + index * 20;
    directory.write(tag, at, "latin1"); directory.writeUInt32BE(position, at + 4); directory.writeUInt32BE(packed.length, at + 8); directory.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([packed, Buffer.alloc((4 - packed.length % 4) % 4)]);
    position += padded.length;
    return padded;
  });
  return Buffer.concat([directory, ...bodies]);
}

const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test("TrueType：中文名称优先、字形数、cmap 字符表", async () => {
  const { sfnt } = fakeFont();
  const info = await readFontInfo(arrayBuffer(sfnt));
  assert.equal(info.format, "TrueType");
  assert.equal(info.family, "测试黑体");
  assert.equal(info.style, "Regular");
  assert.equal(info.version, "Version 1.0");
  assert.equal(info.glyphs, 42);
  assert.deepEqual(info.codepoints, [0x41, 0x42, 0x43, 0x4e2d]);
});

test("WOFF 逐表解压后读出同样的信息；WOFF2 只报格式", async () => {
  const { tables } = fakeFont();
  const info = await readFontInfo(arrayBuffer(toWoff(tables)));
  assert.equal(info.format, "WOFF");
  assert.equal(info.family, "测试黑体");
  assert.deepEqual(info.codepoints, [0x41, 0x42, 0x43, 0x4e2d]);
  const woff2 = await readFontInfo(arrayBuffer(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)])));
  assert.deepEqual(woff2, { format: "WOFF2", codepoints: null });
});
