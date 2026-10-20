import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import * as api from "../api";
import { usePrivateAccess } from "./private-session";
import { PreviewModal, getFileKind } from "../files";

/**
 * 预览弹窗挂在应用外壳上，不随页面切换卸载：用户最小化后去看别的页面，播放不中断；
 * 只有关闭、打开同类文件、退出登录或系统锁定时才结束。
 * 不同类型的预览各占一个槽位（视频、音频、图片、文档），可以同时打开：一边看图一边听音乐或看视频。
 * 打开同类文件替换该槽位；打开另一类时，正在播放的音视频窗口自动收成小窗继续播放。
 * 页面传入的回调（分享、补缩略图、私密空间活动）属于打开它的页面，页面卸载后不再调用。
 * 私密空间的文件在离开私密空间或锁定时立即关闭，不能跟着用户留在普通页面上。
 */
type ModalProps = ComponentProps<typeof PreviewModal>;
export type PreviewRequest = Omit<ModalProps, "onClose" | "minimizeRequest">;
type Slot = "video" | "audio" | "image" | "document";
type Current = { id: number; owner: string; request: PreviewRequest; minimize: number };
type Host = { open: (owner: string, request: PreviewRequest) => void; update: (file: api.FileItem) => void; sync: (owner: string, files: api.FileItem[]) => void; release: (owner: string) => void };

const HostContext = createContext<Host | null>(null);
// 只属于打开页面的回调；页面卸载后从预览中移除，避免调用已卸载页面的状态。
const PAGE_CALLBACKS = ["onShare", "onImageLoad", "onVideoFrame", "onPlaybackActivity"] as const;
const MEDIA_SLOTS: Slot[] = ["video", "audio"];

function slotOf(file: api.FileItem): Slot {
  const kind = getFileKind(file.content_type, file.key);
  return kind === "video" || kind === "audio" || kind === "image" ? kind : "document";
}

/** 对每个槽位应用变换；没有变化时返回原对象，避免无谓的重新渲染。 */
function mapSlots(slots: Map<Slot, Current>, change: (value: Current) => Current | null): Map<Slot, Current> {
  let changed = false;
  const next = new Map<Slot, Current>();
  for (const [slot, value] of slots) {
    const updated = change(value);
    if (updated !== value) changed = true;
    if (updated) next.set(slot, updated);
  }
  return changed ? next : slots;
}

export function PreviewHost({ children, privateAllowed, enabled }: { children: ReactNode; privateAllowed: boolean; enabled: boolean }) {
  const privateSession = usePrivateAccess();
  privateAllowed = privateAllowed && privateSession.grant !== null;
  const [slots, setSlots] = useState<Map<Slot, Current>>(new Map());
  const counter = useRef(0);
  const host = useMemo<Host>(() => ({
    open: (owner, request) => setSlots(current => {
      const slot = slotOf(request.file);
      const next = new Map(current);
      // 另一类预览打开时，正在显示的音视频窗口收成小窗，播放不中断。
      for (const media of MEDIA_SLOTS) {
        const value = next.get(media);
        if (media !== slot && value) next.set(media, { ...value, minimize: value.minimize + 1 });
      }
      next.delete(slot);  // 先删再加，新窗口排在最上层
      next.set(slot, { id: ++counter.current, owner, request, minimize: 0 });
      return next;
    }),
    update: file => setSlots(current => mapSlots(current, value => value.request.file.key === file.key
      ? { ...value, request: { ...value.request, file: { ...value.request.file, ...file } } } : value)),
    // 打开预览的页面刷新了文件信息（补上缩略图、覆盖后的新版本）：同步给预览的当前文件与列表，成员与顺序不变。
    sync: (owner, files) => setSlots(current => mapSlots(current, value => {
      if (value.owner !== owner) return value;
      const latest = new Map(files.map(item => [item.key, item]));
      let changed = false;
      const playlistFiles = value.request.playlistFiles?.map(item => {
        const next = latest.get(item.key);
        if (!next || next === item) return item;
        changed = true; return next;
      });
      const file = latest.get(value.request.file.key) ?? value.request.file;
      if (!changed && file === value.request.file) return value;
      return { ...value, request: { ...value.request, file, playlistFiles } };
    })),
    release: owner => setSlots(current => mapSlots(current, value => {
      if (value.owner !== owner) return value;
      if (api.isPrivatePath(value.request.file.key)) return null;
      const request = { ...value.request };
      for (const name of PAGE_CALLBACKS) delete request[name];
      return { ...value, owner: "", request };
    })),
  }), []);
  const hasPrivate = [...slots.values()].some(value => api.isPrivatePath(value.request.file.key));
  useEffect(() => {
    if (!enabled) setSlots(current => current.size ? new Map() : current);
    else if (hasPrivate && !privateAllowed) setSlots(current => mapSlots(current, value => api.isPrivatePath(value.request.file.key) ? null : value));
  }, [enabled, hasPrivate, privateAllowed]);
  const close = useCallback((id: number) => setSlots(current => mapSlots(current, value => value.id === id ? null : value)), []);
  return <HostContext.Provider value={host}>
    {children}
    {enabled && [...slots.values()].map(value => (!api.isPrivatePath(value.request.file.key) || privateAllowed)
      && <PreviewModal key={value.id} {...value.request} minimizeRequest={value.minimize} onClose={() => close(value.id)} />)}
  </HostContext.Provider>;
}
/** 页面用来打开预览；页面卸载时自动释放它打开的预览。 */
export function usePreview() {
  const host = useContext(HostContext);
  if (!host) throw new Error("usePreview 必须在 PreviewHost 内使用");
  const owner = useId();
  useEffect(() => () => host.release(owner), [host, owner]);
  return {
    open: useCallback((request: PreviewRequest) => host.open(owner, request), [host, owner]),
    update: host.update,
    sync: useCallback((files: api.FileItem[]) => host.sync(owner, files), [host, owner]),
  };
}
