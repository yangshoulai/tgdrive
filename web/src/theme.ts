/** 外观主题：跟随系统、浅色、深色。偏好存在 localStorage，页面加载前由 build-apps.mjs 生成的 theme-*.js 预先应用，避免闪烁。 */
export type ThemePreference = "system" | "light" | "dark";

/* 存储键与解析规则需和 build-apps.mjs 里的 THEME_INIT 保持一致。 */
const STORAGE_KEY = "tessera-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<(preference: ThemePreference) => void>();

export function themePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}

function apply(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch { /* 隐私模式下无法保存，仍对当前页面生效 */ }
  apply(preference);
  listeners.forEach(listener => listener(preference));
}

export function onThemeChange(listener: (preference: ThemePreference) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 跟随系统时，系统切换外观立即生效；其他标签页修改偏好时同步。
const syncSystem = () => { if (themePreference() === "system") apply("system"); };
media.addEventListener("change", syncSystem);
// 兜底：个别环境切换外观时不派发 change 事件，回到页面时再核对一次。
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncSystem(); });
window.addEventListener("focus", syncSystem);
window.addEventListener("storage", event => { if (event.key === STORAGE_KEY) { const preference = themePreference(); apply(preference); listeners.forEach(listener => listener(preference)); } });
apply(themePreference());
