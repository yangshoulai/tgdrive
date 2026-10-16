import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import * as api from "../api";
import { usePrivateAccess } from "./private-session";
import { PreviewModal } from "../files";

/**
 * 预览弹窗挂在应用外壳上，不随页面切换卸载：用户最小化后去看别的页面，播放不中断；
 * 只有关闭、打开另一个文件、退出登录或系统锁定时才结束。
 * 页面传入的回调（分享、补缩略图、私密空间活动）属于打开它的页面，页面卸载后不再调用。
 * 私密空间的文件在离开私密空间或锁定时立即关闭，不能跟着用户留在普通页面上。
 */
type ModalProps = ComponentProps<typeof PreviewModal>;
export type PreviewRequest = Omit<ModalProps, "onClose">;
type Current = { id: number; owner: string; request: PreviewRequest };
type Host = { open: (owner: string, request: PreviewRequest) => void; update: (file: api.FileItem) => void; sync: (owner: string, files: api.FileItem[]) => void; release: (owner: string) => void };

const HostContext = createContext<Host | null>(null);
// 只属于打开页面的回调；页面卸载后从预览中移除，避免调用已卸载页面的状态。
const PAGE_CALLBACKS = ["onShare", "onImageLoad", "onVideoFrame", "onPlaybackActivity"] as const;

export function PreviewHost({ children, privateAllowed, enabled }: { children: ReactNode; privateAllowed: boolean; enabled: boolean }) {
  const privateSession = usePrivateAccess();
  privateAllowed = privateAllowed && privateSession.grant !== null;
  const [current, setCurrent] = useState<Current | null>(null);
  const counter = useRef(0);
  const host = useMemo<Host>(() => ({
    open: (owner, request) => setCurrent({ id: ++counter.current, owner, request }),
    update: file => setCurrent(value => value && value.request.file.key === file.key ? { ...value, request: { ...value.request, file: { ...value.request.file, ...file } } } : value),
    // 打开预览的页面刷新了文件信息（补上缩略图、覆盖后的新版本）：同步给预览的当前文件与列表，成员与顺序不变。
    sync: (owner, files) => setCurrent(value => {
      if (!value || value.owner !== owner) return value;
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
    }),
    release: owner => setCurrent(value => {
      if (!value || value.owner !== owner) return value;
      if (api.isPrivatePath(value.request.file.key)) return null;
      const request = { ...value.request };
      for (const name of PAGE_CALLBACKS) delete request[name];
      return { ...value, owner: "", request };
    }),
  }), []);
  const isPrivate = current !== null && api.isPrivatePath(current.request.file.key);
  useEffect(() => { if (!enabled || isPrivate && !privateAllowed) setCurrent(null); }, [enabled, isPrivate, privateAllowed]);
  return <HostContext.Provider value={host}>
    {children}
    {current && enabled && (!isPrivate || privateAllowed) && <PreviewModal key={current.id} {...current.request} onClose={() => setCurrent(null)} />}
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
