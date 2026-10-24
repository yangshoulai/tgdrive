import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

type PrivateSession = {
  grant: api.PrivateGrant | null; restoring: boolean; error: string; idleSeconds: number; available: boolean;
  beginUnlock: () => (grant: api.PrivateGrant) => void; lock: () => void; restore: () => void;
  observe: (owner: object, selector: string, onLocked: () => void) => () => void;
  playback: (owner: object, state: PreviewPlayback) => void;
};
const PrivateContext = createContext<PrivateSession | null>(null);

/** 生命周期挂在应用外壳；切页不撤销，刷新由服务端按当前登录会话恢复。 */
export function PrivateSessionProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [grant, setGrant] = useState<api.PrivateGrant | null>(null), [restoring, setRestoring] = useState(enabled), [error, setError] = useState("");
  const [idleSeconds, setIdleSeconds] = useState(1800);
  const state = useRef({ grant: null as api.PrivateGrant | null, until: 0, human: 0, reported: 0, revision: 0,
    playing: false, time: 0, progressAt: 0, playbackOwner: null as object | null });
  const areas = useRef(new Map<object, { selector: string; onLocked: () => void }>());
  const beatRef = useRef<() => void>(() => undefined), restoreRef = useRef<() => void>(() => undefined);
  const channel = useRef<BroadcastChannel | null>(null), actionTimer = useRef<number | undefined>();
  const live = useRef(false);
  const pendingLock = useRef<string | null>(null);
  const adopt = useCallback((value: api.PrivateGrant, requestedAt = Date.now()) => {
    const current = state.current;
    current.revision++; current.grant = value; current.until = requestedAt + (value.remaining_seconds ?? value.idle_seconds) * 1000;
    current.human = current.reported = Date.now(); current.playing = false; current.playbackOwner = null;
    api.setPrivateAccess(value.access, current.until); setGrant(value); setIdleSeconds(value.idle_seconds); setRestoring(false); setError("");
  }, []);
  const drop = useCallback(() => {
    const current = state.current;
    const access = current.grant?.access;
    current.revision++; current.grant = null; current.until = 0; current.playing = false; current.playbackOwner = null;
    if (access && api.getPrivateAccess() === access) {
      api.setPrivateAccess("");
      window.dispatchEvent(new CustomEvent("tessera:private-locked", { detail: access }));
    }
    setGrant(null); setRestoring(false);
    if (!access) return;
    for (const area of [...areas.current.values()]) area.onLocked();
  }, []);
  const lock = useCallback(() => {
    const access = state.current.grant?.access ?? pendingLock.current;
    if (!access) return;
    pendingLock.current = access; drop(); setRestoring(true); setError("");
    void api.lockPrivate(access).then(() => { if (pendingLock.current === access) pendingLock.current = null; channel.current?.postMessage("locked"); if (live.current) toast.info("私密空间已锁定"); })
      .catch(() => { if (live.current) setError("服务器未确认锁定，请重试；本页的私密内容已隐藏。"); })
      .finally(() => { if (live.current) setRestoring(false); });
  }, [drop]);
  const interact = useCallback(() => {
    if (!state.current.grant) return;
    state.current.human = Date.now(); window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => beatRef.current(), 250);
  }, []);
  const observe = useCallback((owner: object, selector: string, onLocked: () => void) => {
    areas.current.set(owner, { selector, onLocked }); interact();
    return () => {
      areas.current.delete(owner);
      if (state.current.playbackOwner === owner) { state.current.playing = false; state.current.playbackOwner = null; }
    };
  }, [interact]);
  const playback = useCallback((owner: object, value: PreviewPlayback) => {
    if (!state.current.grant || !areas.current.has(owner)) return;
    const current = state.current, playing = value.playing && value.state !== "failed";
    if (playing && (!current.playing || current.time !== value.currentTime)) current.progressAt = Date.now();
    if (current.playing && !playing) interact();
    current.playing = playing; current.time = value.currentTime; current.playbackOwner = owner;
    if (playing) beatRef.current();
  }, [interact]);
  useEffect(() => {
    if (!enabled) { drop(); api.setPrivateAccess(""); setRestoring(false); return; }
    live.current = true;
    let disposed = false, pending = false, lastBeat = 0;
    const initial = new AbortController();
    const isPlaying = () => state.current.playing && Date.now() - state.current.progressAt < 45000;
    async function restore(signal?: AbortSignal) {
      const revision = ++state.current.revision, requestedAt = Date.now();
      let applied = false;
      setRestoring(true); setError("");
      try {
        const result = await api.privateStatus(signal);
        if (disposed || revision !== state.current.revision) return;
        applied = true;
        setIdleSeconds(result.idle_seconds);
        if (result.unlocked && result.access && result.remaining_seconds > 0) adopt({ access: result.access, idle_seconds: result.idle_seconds, remaining_seconds: result.remaining_seconds }, requestedAt);
        else { drop(); api.setPrivateAccess(""); }
      } catch (reason) {
        if (!disposed && revision === state.current.revision && !signal?.aborted) { applied = true; drop(); setError(api.errorMessage(reason, "无法检查私密空间状态，请重试")); }
      } finally { if (!disposed && (applied || revision === state.current.revision)) setRestoring(false); }
    }
    async function beat() {
      const current = state.current;
      if (disposed || pending || !current.grant || Date.now() - lastBeat < 1000) return;
      pending = true; lastBeat = Date.now();
      const access = current.grant.access, human = current.human, revision = current.revision, requestedAt = Date.now();
      try {
        const result = await api.privateActivity(human > current.reported, isPlaying());
        if (disposed || current.grant?.access !== access || revision !== current.revision) return;
        current.reported = human; current.until = requestedAt + result.remaining_seconds * 1000;
        api.setPrivateAccess(access, current.until);
      } catch (reason) {
        if (!disposed && current.grant?.access === access && revision === current.revision && reason instanceof api.ApiError && (reason.code === "private_locked" || reason.status === 401)) drop();
      } finally { pending = false; }
    }
    // 本地截止时间保守计算；到期先隐藏私密内容，再核对其他标签页是否已续期。
    function check() {
      if (state.current.grant && Date.now() >= state.current.until) { drop(); void restore(); }
    }
    const action = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const restoringPreview = event instanceof KeyboardEvent && event.key.toLowerCase() === "i" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing;
      const minimized = restoringPreview ? document.querySelector(".preview-modal.is-minimized.is-private") : null;
      if ([...areas.current.values()].some(area => (event.target instanceof Element && event.target.closest(area.selector)) || minimized?.matches(area.selector))) interact();
    };
    const expired = (event: Event) => { if ((event as CustomEvent<string>).detail === state.current.grant?.access) { drop(); void restore(); } };
    const policyChanged = () => { drop(); void restore(); channel.current?.postMessage("policy-changed"); };
    const visible = () => { if (!document.hidden) { check(); void beat(); } };
    beatRef.current = () => { if (state.current.human > state.current.reported || Date.now() - lastBeat >= 10000) void beat(); };
    restoreRef.current = () => void restore();
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("tessera-private-lock");
      channel.current.onmessage = event => {
        if (event.data === "locked") drop();
        else if (event.data === "policy-changed") { drop(); void restore(); }
      };
    }
    const checkTimer = window.setInterval(check, 1000), heartbeat = window.setInterval(() => void beat(), 15000);
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) document.addEventListener(name, action, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visible); window.addEventListener("tessera:private-locked", expired);
    window.addEventListener("tessera:private-policy-changed", policyChanged);
    void restore(initial.signal);
    return () => {
      disposed = true; live.current = false; initial.abort(); state.current.revision++;
      window.clearTimeout(actionTimer.current); window.clearInterval(checkTimer); window.clearInterval(heartbeat);
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) document.removeEventListener(name, action, true);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("tessera:private-locked", expired);
      window.removeEventListener("tessera:private-policy-changed", policyChanged);
      channel.current?.close(); channel.current = null; beatRef.current = restoreRef.current = () => undefined;
      state.current.playing = false;
      if (api.getPrivateAccess() === state.current.grant?.access) api.setPrivateAccess("");
      // 页面离开和刷新只释放客户端状态；服务端授权继续按闲置时间到期。
    };
  }, [enabled, adopt, drop]);
  const valid = enabled && grant && Date.now() < state.current.until ? grant : null;
  return createElement(PrivateContext.Provider, { value: { grant: valid, restoring, error, idleSeconds, available: enabled,
    beginUnlock: () => {
      const revision = state.current.revision;
      // 锁定或策略变更后的迟到验证响应不能恢复客户端授权。
      return value => { if (enabled && live.current && revision === state.current.revision && !pendingLock.current) adopt(value); };
    }, lock, restore: () => pendingLock.current ? lock() : restoreRef.current(), observe, playback } }, children);
}

export function usePrivateAccess() {
  const value = useContext(PrivateContext);
  if (!value) throw new Error("私密空间需要挂在 PrivateSessionProvider 内");
  return value;
}

/** 页面只注册私密活动区域及撤销回调，不拥有解锁授权的生命周期。 */
export function usePrivateSession(grant: api.PrivateGrant | null, onLocked: () => void, selector: string) {
  const access = usePrivateAccess(), owner = useRef({}), callback = useRef(onLocked); callback.current = onLocked;
  useEffect(() => {
    if (!grant) return;
    return access.observe(owner.current, selector, () => callback.current());
  }, [grant?.access, selector, access.observe]);
  const onPlayback = useCallback((value: PreviewPlayback) => access.playback(owner.current, value), [access.playback]);
  return { lock: access.lock, onPlayback };
}
