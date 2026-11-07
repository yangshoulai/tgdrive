// 音视频预览的播放快捷键（web/src/preview-keys.ts）：静音、字幕／歌词开关与偏移、按十分位跳转、调速、逐帧。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require(path.join(__dirname, "../web/node_modules/esbuild"));

const bundle = buildSync({ entryPoints: [path.join(__dirname, "../web/src/preview-keys.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", target: "es2022" });
const module_ = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module_, module_.exports);
const { playerShortcut } = module_.exports;

function player() {
  const calls = [];
  let rate = 1, offset = 0;
  return {
    calls,
    seek: time => calls.push(["seek", time]),
    toggleMute: () => calls.push(["mute"]),
    toggleCaptions: () => calls.push(["captions"]),
    adjustRate: delta => (rate += delta),
    shiftCaptions: delta => (offset = Math.round((offset + delta) * 10) / 10),
    step: direction => calls.push(["step", direction]),
    duration: () => 200,
  };
}
const key = (value, extra = {}) => ({ key: value, shiftKey: false, repeat: false, ...extra });

test("数字键按十分位跳转，未知时长时不跳", () => {
  const p = player();
  assert.deepEqual(playerShortcut(key("5"), "video", p), { feedback: null });
  assert.deepEqual(p.calls, [["seek", 100]]);
  const unknown = { ...player(), duration: () => 0 };
  playerShortcut(key("9"), "audio", unknown);
  assert.deepEqual(unknown.calls, []);
});

test("调速：音乐给出状态提示，视频由播放器自己提示", () => {
  const p = player();
  assert.deepEqual(playerShortcut(key(">", { shiftKey: true }), "audio", p), { feedback: { status: "playback-rate", message: "播放速度 1.25×" } });
  assert.deepEqual(playerShortcut(key("<", { shiftKey: true }), "video", p), { feedback: null });
});

test("歌词偏移：延后、提前与还原", () => {
  const p = player();
  assert.equal(playerShortcut(key("h"), "audio", p).feedback.message, "歌词延后 0.5 秒");
  assert.equal(playerShortcut(key("g"), "audio", p).feedback.message, "歌词时间已还原");
  assert.equal(playerShortcut(key("g"), "audio", p).feedback.message, "歌词提前 0.5 秒");
});

test("静音与字幕开关忽略长按重复；逐帧只对视频生效", () => {
  const p = player();
  playerShortcut(key("m"), "audio", p);
  playerShortcut(key("m", { repeat: true }), "audio", p);
  playerShortcut(key("c"), "video", p);
  assert.deepEqual(p.calls, [["mute"], ["captions"]]);
  assert.equal(playerShortcut(key("."), "audio", p), null, "音乐不处理逐帧，交给其他快捷键");
  playerShortcut(key(","), "video", p);
  assert.deepEqual(p.calls.at(-1), ["step", -1]);
});

test("其他按键与 Shift 组合交还给预览窗口", () => {
  const p = player();
  assert.equal(playerShortcut(key("k"), "audio", p), null);
  assert.equal(playerShortcut(key("M", { shiftKey: true }), "audio", p), null);
});
