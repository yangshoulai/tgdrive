// 键盘缩小、平移及收起后的视口恢复；页面锁不能遗留 inert 或覆盖原滚动位置。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { buildSync } = require(path.join(root, "web/node_modules/esbuild"));
const bundle = buildSync({ entryPoints: [path.join(root, "web/src/user/assistant-layout.ts")], bundle: true, write: false, format: "cjs", platform: "node" });
const loaded = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
const { watchAssistantViewport, lockAssistantPage } = loaded.exports;

class Style {
  values = new Map();
  getPropertyValue(key) { return this.values.get(key)?.[0] ?? ""; }
  getPropertyPriority(key) { return this.values.get(key)?.[1] ?? ""; }
  setProperty(key, value, priority = "") { this.values.set(key, [value, priority]); }
  removeProperty(key) { this.values.delete(key); }
}
function fixture() {
  const attributes = new Set(), restored = [];
  const app = { hasAttribute: key => attributes.has(key), setAttribute: key => attributes.add(key), removeAttribute: key => attributes.delete(key) };
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0 });
  const body = { style: new Style() }, node = { style: new Style() };
  global.window = Object.assign(new EventTarget(), { visualViewport: viewport, scrollX: 0, scrollY: 640, scrollTo: (...args) => restored.push(args) });
  global.document = { documentElement: { clientHeight: 844, clientWidth: 390 }, body, getElementById: id => id === "root" ? app : null };
  return { app, viewport, body, node, restored };
}
const value = (node, key) => node.style.getPropertyValue(`--assistant-viewport${key ? `-${key}` : ""}`);

test("键盘 resize 与随后 scroll 均更新抽屉，窄屏使用实际可视宽度", () => {
  const { viewport, node } = fixture();
  const cleanup = watchAssistantViewport(node);
  assert.equal(value(node, "width"), "390px");
  assert.equal(value(node), "844px");
  viewport.height = 430;
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(value(node), "430px");
  viewport.offsetTop = 150;
  viewport.width = 320;
  viewport.offsetLeft = 35;
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(value(node, "top"), "150px");
  assert.equal(value(node, "left"), "35px");
  assert.equal(value(node, "width"), "320px");
  cleanup();
});

test("收起键盘后残留偏移与橡皮筋负偏移不能把抽屉移出屏幕", () => {
  const { viewport, node } = fixture();
  viewport.height = 430;
  viewport.offsetTop = 150;
  const cleanup = watchAssistantViewport(node);
  viewport.height = 844;
  viewport.offsetLeft = 35;
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(value(node, "top"), "0px");
  assert.equal(value(node, "left"), "0px");
  viewport.offsetTop = -30;
  viewport.offsetLeft = -10;
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(value(node, "top"), "0px");
  assert.equal(value(node, "left"), "0px");
  cleanup();
});

test("旋转屏幕更新尺寸，关闭后移除全部监听与视口样式", () => {
  const { viewport, node } = fixture();
  const cleanup = watchAssistantViewport(node);
  document.documentElement.clientHeight = 390;
  document.documentElement.clientWidth = 740;
  viewport.height = 350;
  viewport.width = 740;
  window.dispatchEvent(new Event("resize"));
  assert.equal(value(node), "350px");
  assert.equal(value(node, "width"), "740px");
  cleanup();
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  assert.equal(node.style.values.size, 0);
});

test("无 VisualViewport 的浏览器保留 CSS 尺寸回退", () => {
  const { node } = fixture();
  window.visualViewport = null;
  watchAssistantViewport(node)();
  assert.equal(node.style.values.size, 0);
});

test("手机抽屉阻止底层交互，关闭时恢复滚动位置和原样式", () => {
  const { app, body, restored } = fixture();
  body.style.setProperty("position", "relative");
  body.style.setProperty("overflow", "auto", "important");
  const unlock = lockAssistantPage();
  assert.equal(app.hasAttribute("inert"), true);
  assert.equal(body.style.getPropertyValue("position"), "fixed");
  assert.equal(body.style.getPropertyValue("top"), "-640px");
  unlock();
  assert.equal(app.hasAttribute("inert"), false);
  assert.equal(body.style.getPropertyValue("position"), "relative");
  assert.equal(body.style.getPropertyValue("top"), "");
  assert.equal(body.style.getPropertyValue("overflow"), "auto");
  assert.equal(body.style.getPropertyPriority("overflow"), "important");
  assert.deepEqual(restored, [[0, 640]]);
});

test("多次打开关闭不累积锁，已被其他流程锁定的根节点保持 inert", () => {
  const { app, body } = fixture();
  for (let count = 0; count < 3; count++) {
    lockAssistantPage()();
    assert.equal(app.hasAttribute("inert"), false);
    assert.equal(body.style.values.size, 0);
  }
  app.setAttribute("inert", "");
  lockAssistantPage()();
  assert.equal(app.hasAttribute("inert"), true);
});
