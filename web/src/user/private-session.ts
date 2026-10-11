import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import * as api from "../api";
import type { PreviewPlayback } from "../files";
import { toast } from "../ui";

/** 私密文件提示及撤销回调随页面关闭，异步操作结束后也不能重新展示文件名。 */
export function usePrivateToast(enabled: boolean) {
  const live = useRef(true), ids = useRef<number[]>([]);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; ids.current.forEach(toast.dismiss); ids.current = []; };
  }, [enabled]);
  const push = (create: () => number) => {
    if (!enabled) return create();
    if (!live.current) return;
    const id = create(); ids.current = [...ids.current.slice(-3), id]; return id;
  };
  return {
    success: (...args: Parameters<typeof toast.success>) => push(() => toast.success(...args)),
    error: (message: string) => push(() => toast.error(message)),
    info: (message: string) => push(() => toast.info(message)),
  };
}

/** 解锁只存在当前页面内存；普通请求不续期，短暂缓冲最多宽限 45 秒。 */
export function usePrivateSession(grant: api.PrivateGrant | null, onLocked: () => void, selector: string) {
  const onLockedRef = useRef(onLocked);
  onLockedRef.current = onLocked;
  const finishRef = useRef<() => void>(() => undefined);
  const playback = useRef({ playing: false, time: 0, progressAt: 0 });
  const interactRef = useRef<() => void>(() => undefined);
  const pulseRef = useRef<() => void>(() => undefined);
  const lock = useCallback(() => finishRef.current(), []);
  const onPlayback = useCallback((state: PreviewPlayback) => {
    const now = Date.now(), previous = playback.current;
    const playing = state.playing && state.state !== "failed";
    if (playing && (!previous.playing || state.currentTime !== previous.time)) previous.progressAt = now;
    if (previous.playing && !playing) interactRef.current();
    previous.playing = playing;
    previous.time = state.currentTime;
    if (playing) pulseRef.current();
  }, []);

  useEffect(() => {
    if (!grant) return;
    const access = grant.access;
    api.setPrivateAccess(access);
    let stopped = false, pending = false, lastAction = Date.now(), lastHuman = lastAction, reportedHuman = lastHuman;
    let serverUntil = lastAction + grant.idle_seconds * 1000;
    let activityTimer: number | undefined;
    playback.current = { playing: false, time: 0, progressAt: 0 };
    const isPlaying = () => playback.current.playing && Date.now() - playback.current.progressAt < 45000;
    const finish = (keepalive = false) => {
      if (stopped) return;
      stopped = true;
      if (api.getPrivateAccess() === access) api.setPrivateAccess("");
      void api.lockPrivate(access, keepalive).catch(() => undefined);
      onLockedRef.current();
    };
    const check = () => {
      if (stopped) return;
      const now = Date.now();
      if (isPlaying()) lastAction = now;
      if (now >= Math.min(lastAction + grant.idle_seconds * 1000, serverUntil)) finish();
    };
    const beat = async () => {
      check();
      if (stopped || pending) return;
      pending = true;
      const human = lastHuman;
      const requestedAt = Date.now();
      try {
        const result = await api.privateActivity(human > reportedHuman, isPlaying());
        if (stopped) return;
        reportedHuman = human;
        serverUntil = requestedAt + result.remaining_seconds * 1000;
      } catch (reason) {
        if (reason instanceof api.ApiError && (reason.code === "private_locked" || reason.status === 401)) finish();
      } finally { pending = false; }
    };
    const interact = () => {
      if (stopped) return;
      lastAction = lastHuman = Date.now();
      window.clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => void beat(), 250);
    };
    const action = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const restoring = event instanceof KeyboardEvent && event.key.toLowerCase() === "i"
        && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing
        && document.querySelector(".preview-modal.is-minimized")?.matches(selector);
      if (event.target.closest(selector) || restoring) interact();
    };
    const expired = (event: Event) => { if ((event as CustomEvent<string>).detail === access) finish(); };
    const pagehide = () => finish(true);
    const visible = () => { if (!document.hidden) { check(); void beat(); } };
    finishRef.current = () => finish();
    interactRef.current = interact;
    let lastPulse = Date.now();
    // 后台标签页可能降低计时器频率，原生媒体进度也负责发送播放续期。
    pulseRef.current = () => { if (Date.now() - lastPulse >= 10000) { lastPulse = Date.now(); void beat(); } };
    const checkTimer = window.setInterval(check, 1000);
    const heartbeatTimer = window.setInterval(() => void beat(), 15000);
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) document.addEventListener(name, action, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("tessera:private-locked", expired);
    window.addEventListener("pagehide", pagehide);
    return () => {
      stopped = true;
      window.clearTimeout(activityTimer);
      window.clearInterval(checkTimer); window.clearInterval(heartbeatTimer);
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) document.removeEventListener(name, action, true);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("tessera:private-locked", expired);
      window.removeEventListener("pagehide", pagehide);
      if (api.getPrivateAccess() === access) api.setPrivateAccess("");
      void api.lockPrivate(access).catch(() => undefined);
      interactRef.current = () => undefined;
      pulseRef.current = () => undefined;
      finishRef.current = () => undefined;
    };
  }, [grant, selector]);
  return { lock, onPlayback };
}
