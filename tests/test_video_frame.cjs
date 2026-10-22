// 运行：node --test tests/test_video_frame.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));
const result = buildSync({ entryPoints: [path.join(__dirname, "../web/src/video-frame.ts")], bundle: true, write: false, format: "cjs" });
const module_ = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(module_, module_.exports);
const { videoFramePixelsUsable } = module_.exports;

test("rejects black, white, flat frames and mostly blank frames with small logos", () => {
  for (const sample of [[], new Uint8Array(1024), new Uint8Array(1024).fill(255), new Uint8Array(1024).fill(128),
    [...new Uint8Array(800), ...new Uint8Array(224).fill(144)],
    [...new Uint8Array(800).fill(255), ...new Uint8Array(224).fill(48)]]) assert.equal(videoFramePixelsUsable(sample), false);
});

test("accepts detailed dark scenes and normal letterboxing", () => {
  for (const sample of [Array.from({ length: 1024 }, (_, index) => [28, 64, 50, 110][index % 4]),
    [...new Uint8Array(400), ...Array.from({ length: 624 }, (_, index) => 40 + index % 156)],
    Array.from({ length: 1024 }, (_, index) => 64 + index % 128)]) assert.equal(videoFramePixelsUsable(sample), true);
});

test("rejects colored intros with small logos, smooth gradients and empty letterboxed scenes", () => {
  const frame = pixel => Array.from({ length: 1024 }, (_, index) => pixel(index % 32, Math.floor(index / 32)));
  const samples = [
    ...[32, 64, 96, 128, 160, 200].map(value => frame((x, y) => x >= 26 && y >= 4 && y < 10 ? 230 : value)),
    frame((x, y) => x >= 27 && y >= 4 && y < 10 ? 200 : 30 + x + y),
    frame((x, y) => 40 + x * 4 + y),
    frame((x, y) => y < 6 || y >= 26 ? 0 : 60),
    frame((x, y) => x >= 12 && x < 20 && y >= 12 && y < 20 ? 200 : 64),
  ];
  for (const pixels of samples) assert.equal(videoFramePixelsUsable(pixels), false);
});

test("retains detailed single-tone scenes and detail inside letterboxing", () => {
  for (const letterbox of [false, true]) {
    const pixels = Array.from({ length: 1024 }, (_, index) => {
      const x = index % 32, y = Math.floor(index / 32);
      return letterbox && (y < 6 || y >= 26) ? 0 : 40 + (x * 17 + y * 13) % 100;
    });
    assert.equal(videoFramePixelsUsable(pixels), true);
  }
});
