import type { ClientEnvironment } from "../assistant-api";

/** 仅发送操作指引需要的低熵信息，完整 User-Agent 留在浏览器内。 */
export function assistantEnvironment(): ClientEnvironment {
  const ua = navigator.userAgent;
  const browsers = [
    ["Edge", /Edg(?:A|iOS)?\/(\d+)/], ["Opera", /(?:OPR|OPiOS)\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/], ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Chromium", /Chromium\/(\d+)/], ["Safari", /Version\/(\d+).*Safari/],
  ] as const;
  let browser = "其他", version = "";
  for (const [name, pattern] of browsers) {
    const match = ua.match(pattern);
    if (match) { browser = name; version = match[1]; break; }
  }
  const os = /iPhone|iPad|iPod/.test(ua) || /Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1 ? "iOS"
    : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Windows/.test(ua) ? "Windows"
      : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "其他";
  let timezone = "";
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* 时区不可用时由服务端保留默认值。 */ }
  return { browser, browser_version: version, os, language: navigator.language, timezone, origin: window.location.origin };
}
