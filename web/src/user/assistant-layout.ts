/** 手机助手浮层的可视区域与背景隔离；桌面抽屉不使用这些页面锁和视口修正。 */
export function watchAssistantViewport(node: HTMLElement) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const properties = ["--assistant-viewport", "--assistant-viewport-width", "--assistant-viewport-top", "--assistant-viewport-left"];
  const sync = () => {
    const root = document.documentElement;
    // iOS 收起键盘时偶尔保留旧偏移；不能让已恢复完整高度的抽屉继续偏出屏幕。
    const top = Math.max(0, Math.min(viewport.offsetTop, root.clientHeight - viewport.height));
    const left = Math.max(0, Math.min(viewport.offsetLeft, root.clientWidth - viewport.width));
    [viewport.height, viewport.width, top, left].forEach((value, index) => node.style.setProperty(properties[index], `${value}px`));
  };
  sync();
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  return () => {
    viewport.removeEventListener("resize", sync);
    viewport.removeEventListener("scroll", sync);
    window.removeEventListener("resize", sync);
    properties.forEach(property => node.style.removeProperty(property));
  };
}

/** 抽屉 portal 到 body 后，锁住应用根节点，防止触摸／焦点落到底层文件夹。 */
export function lockAssistantPage() {
  const root = document.getElementById("root"), body = document.body;
  const wasInert = root?.hasAttribute("inert") ?? false;
  const x = window.scrollX, y = window.scrollY;
  const properties = ["position", "top", "left", "width", "overflow"];
  const previous = properties.map(property => [property, body.style.getPropertyValue(property), body.style.getPropertyPriority(property)]);
  root?.setAttribute("inert", "");
  // 仅 overflow:hidden 在 iOS 上仍可能随键盘滚动页面；固定 body 并保留原位置。
  body.style.setProperty("position", "fixed");
  body.style.setProperty("top", `${-y}px`);
  body.style.setProperty("left", `${-x}px`);
  body.style.setProperty("width", "100%");
  body.style.setProperty("overflow", "hidden");
  return () => {
    previous.forEach(([property, value, priority]) => {
      if (value) body.style.setProperty(property, value, priority);
      else body.style.removeProperty(property);
    });
    if (!wasInert) root?.removeAttribute("inert");
    window.scrollTo(x, y);
  };
}
