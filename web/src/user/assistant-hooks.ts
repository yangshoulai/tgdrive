/** 文件助手入口需要的轻量状态：应用外壳一开始就要用到，抽屉本身按需加载（user/assistant.tsx）。 */
import { useCallback, useEffect, useState } from "react";
import * as ai from "../assistant-api";

export function useAssistantConfig(enabled: boolean) {
  const [config, setConfig] = useState<ai.AssistantConfig | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) { setConfig(null); return; }
    void ai.assistantConfig().then(setConfig).catch(() => setConfig(null));
  }, [enabled]);
  useEffect(refresh, [refresh]);
  return { config, refresh };
}

/** 抽屉关闭时也要让人看见的状态：运行中、等待处理的请求数，以及当前对话是否涉及私密空间。 */
export type AssistantDockStatus = { running: boolean; pending: number; private: boolean };

export function useAssistantShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        if (document.querySelector(".modal-backdrop:not(.is-minimized), .menu")) return;
        event.preventDefault();
        if (!event.repeat) toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, toggle]);
}
