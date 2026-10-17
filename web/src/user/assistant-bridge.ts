import { useEffect, useRef } from "react";

/**
 * 浏览器工具的页面桥（docs/assistant-design.md §19.7）：文件页把当前目录、可见条目和选中状态登记在这里，
 * 助手对话框执行 ui_get_view／ui_select／ui_preview 时读取或操作。私密空间页面也登记（prefix 带私密前缀），
 * 只有私密对话（§24.5.4）会读取它；普通对话在私密页面只得到 view=private。
 */
export type FilesBridge = {
  prefix: string;
  ready: () => boolean;
  visible: () => { key: string; size?: number }[];
  total: () => number;
  selected: () => string[];
  select: (keys: string[]) => number;
  preview: (key: string) => boolean;
};

let current: FilesBridge | null = null;

export function filesBridge() { return current; }

/** 等待文件页打开指定目录并加载完成（跳转后的新页面需要一点时间）。 */
export async function waitForFiles(prefix: string, timeout = 30000): Promise<FilesBridge | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (current && current.prefix === prefix && current.ready()) return current;
    await new Promise(resolve => window.setTimeout(resolve, 80));
  }
  return null;
}

/** 文件页调用：bridge 的函数通过 ref 读取最新状态，只在目录变化时重新登记。 */
export function useFilesBridge(enabled: boolean, prefix: string, bridge: Omit<FilesBridge, "prefix">) {
  const latest = useRef(bridge);
  latest.current = bridge;
  useEffect(() => {
    if (!enabled) return;
    const value: FilesBridge = {
      prefix, ready: () => latest.current.ready(), visible: () => latest.current.visible(), total: () => latest.current.total(),
      selected: () => latest.current.selected(), select: keys => latest.current.select(keys), preview: key => latest.current.preview(key),
    };
    current = value;
    return () => { if (current === value) current = null; };
  }, [enabled, prefix]);
}

/** 私密空间页面当前显示的是私密文件还是私密回收站（私密对话的 ui_get_view／ui_navigate 使用）。 */
let privateSection: "files" | "trash" = "files";
export const getPrivateSection = () => privateSection;
export const setPrivateSection = (value: "files" | "trash") => { privateSection = value; };
/** 私密对话的 ui_navigate 切换私密文件／私密回收站：私密空间页面监听这个事件。 */
export const PRIVATE_SECTION_EVENT = "tessera:private-section";
export function openPrivateSection(value: "files" | "trash") {
  window.dispatchEvent(new CustomEvent(PRIVATE_SECTION_EVENT, { detail: value }));
}
